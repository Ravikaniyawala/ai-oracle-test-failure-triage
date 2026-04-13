/**
 * Tests for src/jira-writer.ts
 *
 * All tests stub global fetch so no real network calls are made.
 * Env vars are set/deleted around each test to keep tests isolated.
 */
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_ENV = {
  ATLASSIAN_BASE_URL:    'https://example.atlassian.net',
  ATLASSIAN_TOKEN:       'test-token',
  ATLASSIAN_EMAIL:       'test@example.com',
  ATLASSIAN_PROJECT_KEY: 'QA',
};

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

function clearEnv(): void {
  for (const k of Object.keys(VALID_ENV)) delete process.env[k];
  delete process.env['DRY_RUN'];
}

/** Minimal TriageResult fixture */
function makeResult(overrides: Partial<Record<string, unknown>> = {}): import('../src/types.js').TriageResult {
  return {
    testName:     'suite > test name',
    errorMessage: 'AssertionError: expected true to equal false',
    errorHash:    'abc123',
    file:         'tests/foo.spec.ts',
    duration:     1200,
    retries:      1,
    category:     'REGRESSION' as import('../src/types.js').TriageCategory,
    confidence:   0.9,
    reasoning:    'App behaviour changed after recent commit',
    suggestedFix: 'Revert the change to foo.ts',
    ...overrides,
  } as import('../src/types.js').TriageResult;
}

/** Build a minimal fetch stub that returns the given response once. */
function stubFetch(responses: Array<{ ok: boolean; json?: unknown; text?: string }>): () => void {
  let callIdx = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const resp = responses[callIdx++] ?? responses[responses.length - 1]!;
    return {
      ok:   resp.ok,
      json: async () => resp.json ?? {},
      text: async () => resp.text ?? '',
    } as Response;
  };
  return () => { globalThis.fetch = originalFetch; };
}

// ── oracleFpLabel ─────────────────────────────────────────────────────────────

describe('oracleFpLabel', () => {
  it('returns oracle-fp-<fingerprint>', async () => {
    const { oracleFpLabel } = await import('../src/jira-writer.js');
    assert.equal(oracleFpLabel('abc123ef'), 'oracle-fp-abc123ef');
  });

  it('is deterministic for the same input', async () => {
    const { oracleFpLabel } = await import('../src/jira-writer.js');
    assert.equal(oracleFpLabel('fp1'), oracleFpLabel('fp1'));
  });
});

// ── findExistingJiraByFingerprint ─────────────────────────────────────────────

describe('findExistingJiraByFingerprint', () => {
  afterEach(clearEnv);

  it('returns null when credentials are missing', async () => {
    clearEnv(); // no env vars
    const { findExistingJiraByFingerprint } = await import('../src/jira-writer.js');
    const result = await findExistingJiraByFingerprint('fp1');
    assert.equal(result, null);
  });

  it('returns the existing issue key when Jira search returns a hit', async () => {
    setEnv(VALID_ENV);
    const restore = stubFetch([{
      ok:   true,
      json: { issues: [{ key: 'QA-42' }] },
    }]);
    try {
      const { findExistingJiraByFingerprint } = await import('../src/jira-writer.js');
      const key = await findExistingJiraByFingerprint('deadbeef');
      assert.equal(key, 'QA-42');
    } finally {
      restore();
    }
  });

  it('returns null when Jira search returns no issues', async () => {
    setEnv(VALID_ENV);
    const restore = stubFetch([{ ok: true, json: { issues: [] } }]);
    try {
      const { findExistingJiraByFingerprint } = await import('../src/jira-writer.js');
      const key = await findExistingJiraByFingerprint('deadbeef');
      assert.equal(key, null);
    } finally {
      restore();
    }
  });

  it('returns null (non-fatal) when Jira search request fails', async () => {
    setEnv(VALID_ENV);
    const restore = stubFetch([{ ok: false, text: 'Internal Server Error' }]);
    try {
      const { findExistingJiraByFingerprint } = await import('../src/jira-writer.js');
      const key = await findExistingJiraByFingerprint('deadbeef');
      assert.equal(key, null);
    } finally {
      restore();
    }
  });
});

// ── createJiraDefect ──────────────────────────────────────────────────────────

describe('createJiraDefect', () => {
  afterEach(clearEnv);

  it('returns null and skips fetch when DRY_RUN=true', async () => {
    setEnv({ ...VALID_ENV, DRY_RUN: 'true' });
    let fetchCalled = false;
    const restore = stubFetch([{ ok: true, json: { key: 'QA-99' } }]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => { fetchCalled = true; return origFetch(...args); };
    try {
      const { createJiraDefect } = await import('../src/jira-writer.js');
      const key = await createJiraDefect(makeResult(), 'fp-dry');
      assert.equal(key, null);
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });

  it('returns null when credentials are missing', async () => {
    clearEnv();
    const { createJiraDefect } = await import('../src/jira-writer.js');
    const key = await createJiraDefect(makeResult(), 'fp-nocreds');
    assert.equal(key, null);
  });

  it('returns existing key and skips creation when search finds a match', async () => {
    setEnv(VALID_ENV);
    // First call = search → hit; second call should NOT happen.
    let createCalled = false;
    const origFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async (_url, _init) => {
      callCount++;
      if (callCount === 1) {
        // search
        return { ok: true, json: async () => ({ issues: [{ key: 'QA-55' }] }), text: async () => '' } as Response;
      }
      // create — should not be reached
      createCalled = true;
      return { ok: true, json: async () => ({ key: 'QA-99' }), text: async () => '' } as Response;
    };
    try {
      const { createJiraDefect } = await import('../src/jira-writer.js');
      const key = await createJiraDefect(makeResult(), 'fp-existing');
      assert.equal(key, 'QA-55');
      assert.equal(createCalled, false, 'create endpoint should not be called when search returns a hit');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('creates issue with oracle-fp label when search returns no match', async () => {
    setEnv(VALID_ENV);
    const capturedBodies: unknown[] = [];
    const origFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async (_url, init) => {
      callCount++;
      if (callCount === 1) {
        // search → no match
        return { ok: true, json: async () => ({ issues: [] }), text: async () => '' } as Response;
      }
      // create
      if (init?.body) capturedBodies.push(JSON.parse(init.body as string));
      return { ok: true, json: async () => ({ key: 'QA-77' }), text: async () => '' } as Response;
    };
    try {
      const { createJiraDefect, oracleFpLabel } = await import('../src/jira-writer.js');
      const fp  = 'cafebabe1234';
      const key = await createJiraDefect(makeResult(), fp);
      assert.equal(key, 'QA-77');
      assert.equal(callCount, 2, 'should have made exactly 2 fetch calls (search + create)');
      const body = capturedBodies[0] as { fields: { labels: string[] } };
      assert.ok(
        body.fields.labels.includes(oracleFpLabel(fp)),
        `labels should include ${oracleFpLabel(fp)}, got: ${JSON.stringify(body.fields.labels)}`,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns null when Jira create request fails', async () => {
    setEnv(VALID_ENV);
    const origFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) return { ok: true, json: async () => ({ issues: [] }), text: async () => '' } as Response;
      return { ok: false, json: async () => ({}), text: async () => 'Bad Request' } as Response;
    };
    try {
      const { createJiraDefect } = await import('../src/jira-writer.js');
      const key = await createJiraDefect(makeResult(), 'fp-fail');
      assert.equal(key, null);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
