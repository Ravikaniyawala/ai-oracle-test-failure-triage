/**
 * Tests for degraded-mode behavior in src/index.ts.
 *
 * Each test spawns a real subprocess to exercise the full catch-block path
 * without mocking process.exit.
 *
 * Trigger strategy: set ORACLE_STATE_DB_PATH to a path whose parent directory
 * does not exist.  better-sqlite3 throws immediately when opening such a path,
 * which is caught by the Mode 3 try-catch (initDb is inside it).  This avoids
 * any network calls — no Anthropic API is contacted.
 *
 * Subprocess timeout: 10 s — tsx startup + DB open failure is <1 s.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmp     = join(tmpdir(), 'oracle-degraded-mode-test');
const VERDICT = join(tmp, 'oracle-verdict.json');
// Parent directory does NOT exist — better-sqlite3 throws opening this path.
const BAD_DB  = join(tmp, 'nonexistent-subdir', 'db.db');

mkdirSync(tmp, { recursive: true });

after(() => rmSync(tmp, { recursive: true, force: true }));

// ── helpers ───────────────────────────────────────────────────────────────────

const ORACLE_ROOT = join(new URL(import.meta.url).pathname, '../..');

function runOracle(failureMode: string | undefined): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY:      'test-key-not-used',
    ORACLE_STATE_DB_PATH:   BAD_DB,      // causes initDb() to throw
    ORACLE_VERDICT_PATH:    VERDICT,
    DRY_RUN:                'true',
  };
  if (failureMode !== undefined) {
    env['ORACLE_TRIAGE_FAILURE_MODE'] = failureMode;
  } else {
    // Explicitly unset so we test the real default (fail-closed).
    delete env['ORACLE_TRIAGE_FAILURE_MODE'];
  }
  return spawnSync(
    'npx', ['tsx', 'src/index.ts'],
    { cwd: ORACLE_ROOT, env, encoding: 'utf8', timeout: 10_000 },
  );
}

function readVerdict(): Record<string, unknown> {
  return JSON.parse(readFileSync(VERDICT, 'utf8')) as Record<string, unknown>;
}

function resetVerdict(): void {
  if (existsSync(VERDICT)) rmSync(VERDICT);
}

// ── fail-closed tests ─────────────────────────────────────────────────────────

describe('degraded mode — fail-closed (default)', () => {
  it('exits 1 on Oracle failure (fail-closed mode)', () => {
    resetVerdict();
    const result = runOracle('fail-closed');
    assert.strictEqual(
      result.status, 1,
      `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`,
    );
  });

  it('does NOT write an artifact in fail-closed mode', () => {
    resetVerdict();
    runOracle('fail-closed');
    assert.strictEqual(existsSync(VERDICT), false, 'no artifact must be written in fail-closed mode');
  });
});

// ── pass-through tests ────────────────────────────────────────────────────────

describe('degraded mode — pass-through', () => {
  it('exits 0 on Oracle failure (pass-through mode)', () => {
    resetVerdict();
    const result = runOracle('pass-through');
    assert.strictEqual(
      result.status, 0,
      `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`,
    );
  });

  it('writes oracle-verdict.json with verdict=DEGRADED', () => {
    resetVerdict();
    runOracle('pass-through');
    assert.ok(existsSync(VERDICT), 'oracle-verdict.json must be written in pass-through mode');
    assert.strictEqual(readVerdict()['verdict'], 'DEGRADED');
  });

  it('degraded artifact has degraded=true flag', () => {
    resetVerdict();
    runOracle('pass-through');
    assert.strictEqual(readVerdict()['degraded'], true);
  });

  it('degraded artifact includes a non-empty reason string', () => {
    resetVerdict();
    runOracle('pass-through');
    const v = readVerdict();
    assert.strictEqual(typeof v['reason'], 'string');
    assert.ok((v['reason'] as string).length > 0, 'reason must not be empty');
  });

  it('degraded artifact has zero category counts (not a classification result)', () => {
    resetVerdict();
    runOracle('pass-through');
    const v = readVerdict();
    assert.strictEqual(v['FLAKY'],      0);
    assert.strictEqual(v['REGRESSION'], 0);
    assert.strictEqual(v['NEW_BUG'],    0);
    assert.strictEqual(v['ENV_ISSUE'],  0);
  });
});

// ── default-is-fail-closed ────────────────────────────────────────────────────

describe('degraded mode — default is fail-closed', () => {
  it('exits 1 when ORACLE_TRIAGE_FAILURE_MODE is not set', () => {
    resetVerdict();
    const result = runOracle(undefined);  // env var unset
    assert.strictEqual(
      result.status, 1,
      'unset ORACLE_TRIAGE_FAILURE_MODE must behave as fail-closed (exit 1)',
    );
  });

  it('does NOT write an artifact when ORACLE_TRIAGE_FAILURE_MODE is not set', () => {
    resetVerdict();
    runOracle(undefined);
    assert.strictEqual(existsSync(VERDICT), false);
  });
});
