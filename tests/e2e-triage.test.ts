/**
 * E2E triage pipeline tests
 *
 * Exercises the full triage flow without real API calls:
 *   - Anthropic: intercepted by a local mock HTTP server (ANTHROPIC_BASE_URL)
 *   - Jira:      intercepted by the same mock server (ATLASSIAN_BASE_URL)
 *   - Slack:     intercepted by the same mock server (SLACK_WEBHOOK_URL)
 *
 * Each test spawns `tsx src/index.ts` as a subprocess and verifies:
 *   - exit code
 *   - verdict / decision-summary artifacts on disk
 *   - SQLite state (runs, failures, actions)
 *   - which mock HTTP endpoints were called
 *
 * The mock server reads the desired Anthropic response from a temp file
 * that each test writes before spawning the subprocess, so response fixtures
 * can vary per test without requiring a stateful server.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir, type } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

interface RecordedRequest {
  method: string;
  url:    string;
  body:   string;
}

interface MockServer {
  port:     number;
  requests: RecordedRequest[];
  reset:    () => void;
  close:    () => Promise<void>;
}

// ── Mock HTTP server ──────────────────────────────────────────────────────────

/**
 * Starts a local HTTP server that handles:
 *   POST /v1/messages        → Anthropic Messages API
 *   GET  /rest/api/3/search* → Jira issue search (returns no existing issues)
 *   POST /rest/api/3/issue   → Jira issue create (returns QA-101)
 *   POST /slack*             → Slack webhook (returns 200)
 *
 * The Anthropic response body is read from `anthropicResponseFile` on every
 * request so tests can change the fixture between runs without restarting.
 */
function startMockServer(anthropicResponseFile: string): Promise<MockServer> {
  const requests: RecordedRequest[] = [];

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });

        res.setHeader('Content-Type', 'application/json');

        const url = req.url ?? '/';

        // ── Anthropic Messages API ────────────────────────────────────────
        if (url.startsWith('/v1/messages') && req.method === 'POST') {
          let anthropicPayload: unknown;
          try {
            anthropicPayload = JSON.parse(readFileSync(anthropicResponseFile, 'utf8'));
          } catch {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: { message: 'mock: could not read anthropic response file' } }));
            return;
          }
          res.end(JSON.stringify({
            id:          'msg_e2e_test',
            type:        'message',
            role:        'assistant',
            model:       'claude-sonnet-4-6',
            stop_reason: 'end_turn',
            usage:       { input_tokens: 120, output_tokens: 80 },
            content:     [{ type: 'text', text: JSON.stringify(anthropicPayload) }],
          }));
          return;
        }

        // ── Jira search ───────────────────────────────────────────────────
        if (url.includes('/rest/api/3/search') && req.method === 'GET') {
          res.end(JSON.stringify({ issues: [], total: 0 }));
          return;
        }

        // ── Jira create ───────────────────────────────────────────────────
        if (url.includes('/rest/api/3/issue') && req.method === 'POST') {
          res.statusCode = 201;
          res.end(JSON.stringify({ id: '10001', key: 'QA-101' }));
          return;
        }

        // ── Slack webhook ─────────────────────────────────────────────────
        if (url.startsWith('/slack') && req.method === 'POST') {
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: `mock: unhandled ${req.method} ${url}` }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port:     addr.port,
        requests,
        reset:    () => { requests.length = 0; },
        close:    () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ── subprocess runner ─────────────────────────────────────────────────────────

interface OracleRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the Oracle subprocess asynchronously.
 *
 * MUST be async (not `spawnSync`) because the mock HTTP server runs in THIS
 * same process — `spawnSync` blocks the event loop, which would prevent the
 * server from ever responding to the subprocess's Anthropic call, deadlocking
 * both sides until the 20s timeout fires.
 */
function runOracle(env: Record<string, string>): Promise<OracleRun> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      cwd: process.cwd(),
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => outChunks.push(c));
    child.stderr.on('data', (c: Buffer) => errChunks.push(c));

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 20_000);

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({
        status: timedOut ? -1 : (code ?? (signal ? 128 : -1)),
        stdout,
        stderr: timedOut ? stderr + `\n[runOracle] timed out after 20s` : stderr,
      });
    });
  });
}

// ── SQLite reader ─────────────────────────────────────────────────────────────

interface DbSnapshot {
  runs:     unknown[];
  failures: unknown[];
  actions:  unknown[];
}

function readDbSnapshot(dbPath: string): DbSnapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      runs:     db.prepare('SELECT * FROM runs     ORDER BY id').all(),
      failures: db.prepare('SELECT * FROM failures ORDER BY id').all(),
      actions:  db.prepare('SELECT * FROM actions  ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

// ── Report fixtures ───────────────────────────────────────────────────────────

// Stable error messages used across tests — the hash is deterministic.
const REGRESSION_ERROR = 'AssertionError: expected HTTP status 200 received 401 — auth endpoint rejected valid credentials';
const TIMEOUT_ERROR    = 'Error: locator.waitFor timeout exceeded 30000ms waiting for #submit-button';

/**
 * Build a minimal Playwright JSON report.
 * specs is an array of { suiteTitle, specTitle, file, status, errors?, retry?, duration? }.
 */
function makePlaywrightReport(specs: Array<{
  suiteTitle: string;
  specTitle:  string;
  file:       string;
  status:     'failed' | 'passed' | 'timedOut';
  errors?:    string[];
  retry?:     number;
  duration?:  number;
}>): string {
  // Group specs by suiteTitle
  const suiteMap = new Map<string, typeof specs>();
  for (const s of specs) {
    if (!suiteMap.has(s.suiteTitle)) suiteMap.set(s.suiteTitle, []);
    suiteMap.get(s.suiteTitle)!.push(s);
  }

  const suites = Array.from(suiteMap.entries()).map(([title, items]) => ({
    title,
    specs: items.map(s => ({
      title: s.specTitle,
      file:  s.file,
      tests: [{
        results: [{
          status:   s.status,
          retry:    s.retry   ?? 0,
          duration: s.duration ?? 500,
          errors:   (s.errors ?? []).map(msg => ({ message: msg })),
        }],
      }],
    })),
  }));

  return JSON.stringify({ suites, errors: [], stats: {} });
}

// ── Anthropic response fixtures ───────────────────────────────────────────────

/**
 * Returns the triage JSON object that the mock Anthropic server will serve.
 * Must include `testName` matching the failure's derived name
 * (`${suiteTitle} > ${specTitle}`), one result per failure (by index).
 */
function makeAnthropicResponse(results: Array<{
  testName:      string;
  category:      string;
  confidence:    number;
  reasoning:     string;
  suggested_fix: string;
}>): string {
  return JSON.stringify({ results });
}

// ── Test env builder ──────────────────────────────────────────────────────────

function buildEnv(opts: {
  port:          number;
  reportFile:    string;
  dbFile:        string;
  verdictFile:   string;
  summaryFile:   string;
  pipelineId?:   string;
  dryRun?:       boolean;
}): Record<string, string> {
  return {
    ANTHROPIC_API_KEY:      'test-key-e2e',
    ANTHROPIC_BASE_URL:     `http://127.0.0.1:${opts.port}`,
    ATLASSIAN_BASE_URL:     `http://127.0.0.1:${opts.port}`,
    ATLASSIAN_TOKEN:        'test-atlassian-token',
    ATLASSIAN_EMAIL:        'test@example.com',
    ATLASSIAN_PROJECT_KEY:  'QA',
    SLACK_WEBHOOK_URL:      `http://127.0.0.1:${opts.port}/slack-webhook`,
    PLAYWRIGHT_REPORT_PATH: opts.reportFile,
    ORACLE_STATE_DB_PATH:   opts.dbFile,
    ORACLE_VERDICT_PATH:    opts.verdictFile,
    ORACLE_DECISION_SUMMARY_PATH: opts.summaryFile,
    CI_PIPELINE_ID:         opts.pipelineId ?? 'e2e-test-pipeline',
    DRY_RUN:                opts.dryRun ? 'true' : 'false',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E triage — dry-run mode', () => {
  let server!:              MockServer;
  let tmpDir!:              string;
  let anthropicRespFile!:   string;

  before(async () => {
    tmpDir            = mkdtempSync(join(tmpdir(), 'oracle-e2e-dry-'));
    anthropicRespFile = join(tmpDir, 'anthropic-response.json');
    server            = await startMockServer(anthropicRespFile);
  });

  after(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('REGRESSION + FLAKY failures → BLOCKED verdict, no Jira/Slack calls', async () => {
    // ── fixtures ──────────────────────────────────────────────────────────
    const reportFile  = join(tmpDir, 'report-dry1.json');
    const dbFile      = join(tmpDir, 'db-dry1.db');
    const verdictFile = join(tmpDir, 'verdict-dry1.json');
    const summaryFile = join(tmpDir, 'summary-dry1.md');

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Auth',     specTitle: 'login rejects invalid token', file: 'tests/auth.spec.ts',     status: 'failed',   errors: [REGRESSION_ERROR] },
      { suiteTitle: 'Checkout', specTitle: 'payment times out',            file: 'tests/checkout.spec.ts', status: 'timedOut', errors: [TIMEOUT_ERROR], retry: 2 },
      { suiteTitle: 'Smoke',    specTitle: 'homepage loads',               file: 'tests/smoke.spec.ts',    status: 'passed' },
    ]));

    writeFileSync(anthropicRespFile, makeAnthropicResponse([
      { testName: 'Auth > login rejects invalid token',     category: 'REGRESSION', confidence: 0.92, reasoning: 'Auth endpoint returned 401 after recent change', suggested_fix: 'Revert auth middleware change' },
      { testName: 'Checkout > payment times out',            category: 'FLAKY',      confidence: 0.80, reasoning: 'Timeout with retries suggests intermittent issue', suggested_fix: 'Increase locator timeout' },
    ]));

    server.reset();

    // ── run ───────────────────────────────────────────────────────────────
    const run = await runOracle(buildEnv({ port: server.port, reportFile, dbFile, verdictFile, summaryFile, dryRun: true }));

    // Oracle exits 0 even on BLOCKED — exit code 1 only on Oracle-level errors
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    // ── verdict artifact ──────────────────────────────────────────────────
    assert.ok(existsSync(verdictFile), 'verdict file should exist');
    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8')) as Record<string, unknown>;
    assert.equal(verdict['verdict'],    'BLOCKED');
    assert.equal(verdict['REGRESSION'], 1);
    assert.equal(verdict['FLAKY'],      1);
    assert.equal(verdict['NEW_BUG'],    0);
    assert.equal(verdict['ENV_ISSUE'],  0);

    // ── Jira and Slack must NOT be called in dry-run ───────────────────────
    const jiraCalls  = server.requests.filter(r => r.url.includes('/rest/api/3/issue'));
    const slackCalls = server.requests.filter(r => r.url.startsWith('/slack'));
    assert.equal(jiraCalls.length,  0, 'Jira create must not be called in dry-run');
    assert.equal(slackCalls.length, 0, 'Slack must not be called in dry-run');

    // ── SQLite: run + failures saved, action approved but not executed ────
    const snap = readDbSnapshot(dbFile);
    assert.equal((snap.runs as unknown[]).length, 1, 'one run saved');
    assert.equal((snap.failures as unknown[]).length, 2, 'two failures saved');

    const jiraAction = (snap.actions as Array<Record<string, unknown>>)
      .find(a => a['action_type'] === 'create_jira');
    assert.ok(jiraAction, 'create_jira action should exist');
    assert.equal(jiraAction['verdict'],      'approved');
    assert.equal(jiraAction['execution_ok'], 0, 'execution_ok=0 in dry-run (Jira skipped)');
  });

  it('FLAKY-only failures → CLEAR verdict, no create_jira action proposed', async () => {
    const reportFile  = join(tmpDir, 'report-dry2.json');
    const dbFile      = join(tmpDir, 'db-dry2.db');
    const verdictFile = join(tmpDir, 'verdict-dry2.json');
    const summaryFile = join(tmpDir, 'summary-dry2.md');

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Checkout', specTitle: 'payment times out', file: 'tests/checkout.spec.ts', status: 'timedOut', errors: [TIMEOUT_ERROR], retry: 1 },
    ]));

    writeFileSync(anthropicRespFile, makeAnthropicResponse([
      { testName: 'Checkout > payment times out', category: 'FLAKY', confidence: 0.85, reasoning: 'Timeout with retries', suggested_fix: 'Increase timeout' },
    ]));

    server.reset();

    const run = await runOracle(buildEnv({ port: server.port, reportFile, dbFile, verdictFile, summaryFile, dryRun: true }));
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8')) as Record<string, unknown>;
    assert.equal(verdict['verdict'], 'CLEAR', 'FLAKY-only should not block');
    assert.equal(verdict['FLAKY'],   1);

    // No create_jira action — FLAKY does not trigger Jira proposal
    const snap       = readDbSnapshot(dbFile);
    const jiraAction = (snap.actions as Array<Record<string, unknown>>)
      .find(a => a['action_type'] === 'create_jira');
    assert.ok(!jiraAction, 'create_jira must not be proposed for FLAKY-only failures');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('E2E triage — live mode (Jira + Slack side effects)', () => {
  let server!:              MockServer;
  let tmpDir!:              string;
  let anthropicRespFile!:   string;

  // Shared DB across tests in this group — used to verify dedup on second run.
  let sharedDbFile!:        string;

  before(async () => {
    tmpDir            = mkdtempSync(join(tmpdir(), 'oracle-e2e-live-'));
    anthropicRespFile = join(tmpDir, 'anthropic-response.json');
    sharedDbFile      = join(tmpDir, 'db-shared.db');
    server            = await startMockServer(anthropicRespFile);
  });

  after(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('REGRESSION + FLAKY → Jira created for REGRESSION, Slack posted, SQLite execution_ok=1', async () => {
    const reportFile  = join(tmpDir, 'report-live1.json');
    const verdictFile = join(tmpDir, 'verdict-live1.json');
    const summaryFile = join(tmpDir, 'summary-live1.md');

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Auth',     specTitle: 'login rejects invalid token', file: 'tests/auth.spec.ts',     status: 'failed',   errors: [REGRESSION_ERROR] },
      { suiteTitle: 'Checkout', specTitle: 'payment times out',            file: 'tests/checkout.spec.ts', status: 'timedOut', errors: [TIMEOUT_ERROR], retry: 2 },
    ]));

    writeFileSync(anthropicRespFile, makeAnthropicResponse([
      { testName: 'Auth > login rejects invalid token', category: 'REGRESSION', confidence: 0.92, reasoning: 'Auth change broke login', suggested_fix: 'Revert auth change' },
      { testName: 'Checkout > payment times out',        category: 'FLAKY',      confidence: 0.80, reasoning: 'Intermittent timeout',   suggested_fix: 'Increase timeout' },
    ]));

    server.reset();

    const run = await runOracle(buildEnv({
      port: server.port, reportFile, dbFile: sharedDbFile, verdictFile, summaryFile,
      pipelineId: 'e2e-live-run-001', dryRun: false,
    }));
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    // ── verdict ───────────────────────────────────────────────────────────
    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8')) as Record<string, unknown>;
    assert.equal(verdict['verdict'], 'BLOCKED');

    // ── Jira: search + create both called ────────────────────────────────
    const jiraSearch = server.requests.filter(r => r.url.includes('/rest/api/3/search'));
    const jiraCreate = server.requests.filter(r => r.url.includes('/rest/api/3/issue') && r.method === 'POST');
    assert.ok(jiraSearch.length > 0, 'Jira search should be called');
    assert.ok(jiraCreate.length > 0, 'Jira create should be called');

    // The created issue should carry the oracle-fp label
    const createBody = JSON.parse(jiraCreate[0]!.body) as { fields: { labels: string[] } };
    const fpLabel    = createBody.fields.labels.find((l: string) => l.startsWith('oracle-fp-'));
    assert.ok(fpLabel, `oracle-fp label missing from created issue; labels: ${JSON.stringify(createBody.fields.labels)}`);

    // ── Slack posted ──────────────────────────────────────────────────────
    const slackCalls = server.requests.filter(r => r.url.startsWith('/slack'));
    assert.ok(slackCalls.length > 0, 'Slack webhook should be called');

    // ── SQLite: execution_ok=1, Jira key in detail ────────────────────────
    const snap       = readDbSnapshot(sharedDbFile);
    const jiraAction = (snap.actions as Array<Record<string, unknown>>)
      .find(a => a['action_type'] === 'create_jira' && a['verdict'] === 'approved');
    assert.ok(jiraAction, 'approved create_jira action should exist');
    assert.equal(jiraAction['execution_ok'], 1, 'execution_ok should be 1 after successful Jira create');

    const detail = String(jiraAction['execution_detail'] ?? '');
    assert.ok(detail.includes('QA-101'), `execution_detail should contain 'QA-101', got: ${detail}`);
  });

  it('second run with same DB → fingerprint stable, Jira creation deduped by SQLite', async () => {
    // Re-use the EXACT same report (same error messages → same error hashes → same fingerprints)
    const reportFile  = join(tmpDir, 'report-live2.json');
    const verdictFile = join(tmpDir, 'verdict-live2.json');
    const summaryFile = join(tmpDir, 'summary-live2.md');

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Auth',     specTitle: 'login rejects invalid token', file: 'tests/auth.spec.ts',     status: 'failed',   errors: [REGRESSION_ERROR] },
      { suiteTitle: 'Checkout', specTitle: 'payment times out',            file: 'tests/checkout.spec.ts', status: 'timedOut', errors: [TIMEOUT_ERROR], retry: 2 },
    ]));

    writeFileSync(anthropicRespFile, makeAnthropicResponse([
      { testName: 'Auth > login rejects invalid token', category: 'REGRESSION', confidence: 0.92, reasoning: 'Auth change broke login', suggested_fix: 'Revert auth change' },
      { testName: 'Checkout > payment times out',        category: 'FLAKY',      confidence: 0.80, reasoning: 'Intermittent timeout',   suggested_fix: 'Increase timeout' },
    ]));

    server.reset();

    const run = await runOracle(buildEnv({
      port: server.port, reportFile, dbFile: sharedDbFile, verdictFile, summaryFile,
      pipelineId: 'e2e-live-run-002',  // different pipeline, same DB
      dryRun: false,
    }));
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    // SQLite dedup check fires before Jira API → Jira create should NOT be called
    const jiraCreate = server.requests.filter(r => r.url.includes('/rest/api/3/issue') && r.method === 'POST');
    assert.equal(jiraCreate.length, 0, 'Jira create must be deduped on second run with same DB');

    // The new run's create_jira action should be rejected, not approved
    const snap       = readDbSnapshot(sharedDbFile);
    // There are now 2 runs; get actions for the latest run
    const runs       = snap.runs as Array<Record<string, unknown>>;
    assert.equal(runs.length, 2, 'should have two runs in DB');
    const secondRunId  = runs[1]!['id'];
    const secondRunActions = (snap.actions as Array<Record<string, unknown>>)
      .filter(a => a['run_id'] === secondRunId && a['action_type'] === 'create_jira');
    assert.ok(secondRunActions.length > 0, 'create_jira action should still be recorded (as rejected)');
    const rejectedJira = secondRunActions.find(a => a['verdict'] === 'rejected');
    assert.ok(rejectedJira, 'second-run create_jira should be rejected by history dedupe');
    assert.ok(
      String(rejectedJira['decision_reason']).startsWith('history:'),
      `expected history: rejection, got: ${rejectedJira['decision_reason']}`,
    );
  });

  it('all-pass report → CLEAR verdict, no actions created', async () => {
    const reportFile  = join(tmpDir, 'report-live3.json');
    const dbFile      = join(tmpDir, 'db-live3.db');
    const verdictFile = join(tmpDir, 'verdict-live3.json');
    const summaryFile = join(tmpDir, 'summary-live3.md');

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Smoke', specTitle: 'homepage loads',    file: 'tests/smoke.spec.ts', status: 'passed' },
      { suiteTitle: 'Smoke', specTitle: 'dashboard renders', file: 'tests/smoke.spec.ts', status: 'passed' },
    ]));

    // LLM should not be called for a zero-failure report — but write a response
    // file anyway so the server doesn't 500 if it somehow is called.
    writeFileSync(anthropicRespFile, makeAnthropicResponse([]));
    server.reset();

    const run = await runOracle(buildEnv({ port: server.port, reportFile, dbFile, verdictFile, summaryFile }));
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8')) as Record<string, unknown>;
    assert.equal(verdict['verdict'], 'CLEAR');

    const snap = readDbSnapshot(dbFile);
    const jiraActions = (snap.actions as Array<Record<string, unknown>>)
      .filter(a => a['action_type'] === 'create_jira');
    assert.equal(jiraActions.length, 0, 'no create_jira actions should exist for all-pass run');

    const jiraCreate = server.requests.filter(r => r.url.includes('/rest/api/3/issue') && r.method === 'POST');
    assert.equal(jiraCreate.length, 0, 'Jira create must not be called for zero failures');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('E2E triage — policy decisions', () => {
  let server!:              MockServer;
  let tmpDir!:              string;
  let anthropicRespFile!:   string;

  before(async () => {
    tmpDir            = mkdtempSync(join(tmpdir(), 'oracle-e2e-policy-'));
    anthropicRespFile = join(tmpDir, 'anthropic-response.json');
    server            = await startMockServer(anthropicRespFile);
  });

  after(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('REGRESSION with confidence < 0.7 → BLOCKED verdict but no Jira proposed', async () => {
    const reportFile  = join(tmpDir, 'report-policy1.json');
    const dbFile      = join(tmpDir, 'db-policy1.db');
    const verdictFile = join(tmpDir, 'verdict-policy1.json');
    const summaryFile = join(tmpDir, 'summary-policy1.md');

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Auth', specTitle: 'login rejects invalid token', file: 'tests/auth.spec.ts', status: 'failed', errors: [REGRESSION_ERROR] },
    ]));

    // Confidence 0.60 — below the 0.7 threshold in proposeFailureActions()
    writeFileSync(anthropicRespFile, makeAnthropicResponse([
      { testName: 'Auth > login rejects invalid token', category: 'REGRESSION', confidence: 0.60, reasoning: 'Possible regression', suggested_fix: 'Investigate auth layer' },
    ]));

    server.reset();

    const run = await runOracle(buildEnv({ port: server.port, reportFile, dbFile, verdictFile, summaryFile }));
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    // REGRESSION still makes verdict BLOCKED regardless of confidence
    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8')) as Record<string, unknown>;
    assert.equal(verdict['verdict'], 'BLOCKED');

    // But no create_jira action is proposed (confidence < 0.7)
    const snap       = readDbSnapshot(dbFile);
    const jiraAction = (snap.actions as Array<Record<string, unknown>>)
      .find(a => a['action_type'] === 'create_jira');
    assert.ok(!jiraAction, 'create_jira must not be proposed for REGRESSION with confidence < 0.7');

    const jiraCreate = server.requests.filter(r => r.url.includes('/rest/api/3/issue') && r.method === 'POST');
    assert.equal(jiraCreate.length, 0, 'Jira create must not be called for low-confidence REGRESSION');
  });

  it('decision summary artifact is written with meaningful content', async () => {
    const reportFile  = join(tmpDir, 'report-policy2.json');
    const dbFile      = join(tmpDir, 'db-policy2.db');
    const verdictFile = join(tmpDir, 'verdict-policy2.json');
    const summaryFile = join(tmpDir, 'summary-policy2.md');

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Auth', specTitle: 'login rejects invalid token', file: 'tests/auth.spec.ts', status: 'failed', errors: [REGRESSION_ERROR] },
    ]));

    writeFileSync(anthropicRespFile, makeAnthropicResponse([
      { testName: 'Auth > login rejects invalid token', category: 'REGRESSION', confidence: 0.88, reasoning: 'Auth endpoint returned 401', suggested_fix: 'Revert auth change' },
    ]));

    server.reset();

    const run = await runOracle(buildEnv({ port: server.port, reportFile, dbFile, verdictFile, summaryFile }));
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    assert.ok(existsSync(summaryFile), 'decision summary markdown should be written');
    const summary = readFileSync(summaryFile, 'utf8');
    assert.ok(summary.length > 0, 'decision summary must not be empty');
    // Contains at least the pipeline ID in the summary
    assert.ok(summary.includes('e2e-test-pipeline'), `summary should reference pipeline ID, got: ${summary.slice(0, 200)}`);
  });

  it('NEW_BUG with confidence > 0.7 → BLOCKED and Jira created', async () => {
    const reportFile  = join(tmpDir, 'report-policy3.json');
    const dbFile      = join(tmpDir, 'db-policy3.db');
    const verdictFile = join(tmpDir, 'verdict-policy3.json');
    const summaryFile = join(tmpDir, 'summary-policy3.md');

    const newBugError = 'TypeError: Cannot read property "submit" of undefined — feature flag missing';

    writeFileSync(reportFile, makePlaywrightReport([
      { suiteTitle: 'Feature', specTitle: 'submit button is visible', file: 'tests/feature.spec.ts', status: 'failed', errors: [newBugError] },
    ]));

    writeFileSync(anthropicRespFile, makeAnthropicResponse([
      { testName: 'Feature > submit button is visible', category: 'NEW_BUG', confidence: 0.82, reasoning: 'Feature not yet implemented', suggested_fix: 'Implement submit feature' },
    ]));

    server.reset();

    const run = await runOracle(buildEnv({ port: server.port, reportFile, dbFile, verdictFile, summaryFile, dryRun: false }));
    assert.equal(run.status, 0, `unexpected exit code — stderr: ${run.stderr}`);

    const verdict = JSON.parse(readFileSync(verdictFile, 'utf8')) as Record<string, unknown>;
    assert.equal(verdict['verdict'],  'BLOCKED');
    assert.equal(verdict['NEW_BUG'], 1);

    const jiraCreate = server.requests.filter(r => r.url.includes('/rest/api/3/issue') && r.method === 'POST');
    assert.ok(jiraCreate.length > 0, 'Jira should be created for NEW_BUG with confidence > 0.7');

    const snap       = readDbSnapshot(dbFile);
    const jiraAction = (snap.actions as Array<Record<string, unknown>>)
      .find(a => a['action_type'] === 'create_jira' && a['verdict'] === 'approved');
    assert.ok(jiraAction, 'approved create_jira action should be recorded for NEW_BUG');
  });
});
