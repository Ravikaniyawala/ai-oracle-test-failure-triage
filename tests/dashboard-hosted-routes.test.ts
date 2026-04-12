/**
 * Integration tests for hosted-mode dashboard routes.
 *
 * Verifies the /api/repos/:repoId/* surface that is enabled when
 * ORACLE_SNAPSHOT_ROOT is set, plus the /repos/:repoId shell routes.
 *
 * A real SQLite snapshot DB is seeded in a temp directory; an Express server
 * is spun up on a random port using createDashboardRouter() with the env var
 * pointing at that temp directory.
 *
 * These tests complement dashboard-server.test.ts (which covers /api/v1/*) and
 * ensure the hosted-mode code paths have automated coverage rather than relying
 * on inspection alone.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ID           = 'test-repo-abc';
const REPO_NAME         = 'test-org/test-repo';
const REPO_DISPLAY_NAME = 'test-repo';
const UNKNOWN_REPO_ID   = 'nonexistent-repo';

// ── Seed helper ───────────────────────────────────────────────────────────────

/**
 * Create a minimal but fully-functional snapshot DB with:
 *   - 1 BLOCKED run with 2 REGRESSION failures
 *   - 1 approved create_jira action
 *   - 1 rejected create_jira action with history-based reason (for suppression route)
 */
function seedSnapshotDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      total_failures INTEGER NOT NULL,
      categories_json TEXT NOT NULL,
      verdict TEXT NOT NULL DEFAULT 'BLOCKED',
      repo_id TEXT,
      repo_name TEXT,
      repo_display_name TEXT
    );
    CREATE TABLE IF NOT EXISTS failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      test_name TEXT NOT NULL,
      error_hash TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      failure_id INTEGER,
      cluster_key TEXT,
      scope TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_fingerprint TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'policy',
      verdict TEXT NOT NULL,
      payload_json TEXT,
      risk_score REAL,
      decision_reason TEXT,
      confidence REAL,
      created_at TEXT,
      executed_at TEXT,
      execution_ok INTEGER,
      execution_detail TEXT
    );
  `);

  db.prepare(
    `INSERT INTO runs (timestamp, pipeline_id, total_failures, categories_json, verdict)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('2026-04-10T10:00:00.000Z', 'hosted-pipe-1', 2, '{"REGRESSION":2}', 'BLOCKED');

  db.prepare(
    `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(1, 'ProductSearchTest.searchWithWrongPrice', 'reg001', 'REGRESSION', 0.95);

  db.prepare(
    `INSERT INTO failures (run_id, test_name, error_hash, category, confidence)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(1, 'PriceValidationTest.validateGST', 'reg002', 'REGRESSION', 0.88);

  // Approved action (execution_ok = 1 makes it count as a Jira created)
  db.prepare(
    `INSERT INTO actions
       (run_id, scope, action_type, action_fingerprint, source, verdict, created_at, executed_at, execution_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(1, 'run', 'create_jira', 'hosted-fp-001', 'policy', 'approved',
        '2026-04-10T10:00:00.000Z', '2026-04-10T10:01:00.000Z', 1);

  // History-based rejection — makes suppression route return data
  db.prepare(
    `INSERT INTO actions
       (run_id, scope, action_type, action_fingerprint, source, verdict, decision_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(1, 'run', 'create_jira', 'hosted-fp-002', 'policy', 'rejected',
        'history:jira_already_created', '2026-04-10T10:00:00.000Z');

  db.close();
}

// ── Test setup ────────────────────────────────────────────────────────────────

let server:    http.Server;
let baseUrl:   string;
let tmpDir:    string;
let fakeUiDir: string;

async function get(urlPath: string): Promise<Response> {
  return fetch(`${baseUrl}${urlPath}`);
}

async function getJson(urlPath: string): Promise<unknown> {
  return (await get(urlPath)).json();
}

before(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'oracle-hosted-routes-test-'));

  // ── Build snapshot dir structure ──────────────────────────────────────────
  const repoDir   = path.join(tmpDir, 'repos', REPO_ID);
  const eventsDir = path.join(repoDir, 'events');
  mkdirSync(eventsDir, { recursive: true });

  seedSnapshotDb(path.join(repoDir, 'latest.db'));

  const manifest = {
    schema_version:    1,
    repo_id:           REPO_ID,
    repo_name:         REPO_NAME,
    repo_display_name: REPO_DISPLAY_NAME,
    updated_at:        '2026-04-10T10:00:00.000Z',
    latest_run_id:     'hosted-pipe-1',
    latest_verdict:    'BLOCKED',
    db_key:            `repos/${REPO_ID}/latest.db`,
  };
  writeFileSync(path.join(repoDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // ── Fake UI dist for shell-route tests ───────────────────────────────────
  fakeUiDir = path.join(tmpDir, 'ui-dist');
  mkdirSync(fakeUiDir, { recursive: true });
  writeFileSync(
    path.join(fakeUiDir, 'index.html'),
    '<!DOCTYPE html><html><body>Oracle Dashboard</body></html>',
  );

  // ── Set env vars before importing router ──────────────────────────────────
  process.env['ORACLE_SNAPSHOT_ROOT'] = tmpDir;

  // Provide a valid (empty) state DB for the global /api/v1/* routes so
  // initDb() doesn't fail — the hosted routes open their own connections.
  const stateDbPath = path.join(tmpDir, 'state.db');
  const stateDb     = new Database(stateDbPath);
  stateDb.exec('CREATE TABLE IF NOT EXISTS _init (id INTEGER PRIMARY KEY)');
  stateDb.close();
  process.env['ORACLE_STATE_DB_PATH'] = stateDbPath;

  // Dynamic import after env is set (ESM module cache is fine — the router
  // factory reads ORACLE_SNAPSHOT_ROOT at call time, not at module load).
  const { initDb }                = await import('../src/state-store.js');
  const { createDashboardRouter } = await import('../src/dashboard-routes.js');

  initDb();

  const app = express();
  app.use(createDashboardRouter('', fakeUiDir));

  await new Promise<void>(resolve => {
    server = app.listen(0, resolve);
  });

  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

after(() => {
  server?.close();
  delete process.env['ORACLE_SNAPSHOT_ROOT'];
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Meta / listing routes ─────────────────────────────────────────────────────

describe('GET /api/repos', () => {
  it('returns an array of manifests', async () => {
    const body = await getJson('/api/repos');
    assert.ok(Array.isArray(body));
  });

  it('includes the seeded repo', async () => {
    const body = await getJson('/api/repos') as Array<Record<string, unknown>>;
    const repo = body.find(r => r['repo_id'] === REPO_ID);
    assert.ok(repo !== undefined, 'seeded repo should appear in the list');
  });

  it('manifest entry has expected shape', async () => {
    const body  = await getJson('/api/repos') as Array<Record<string, unknown>>;
    const repo  = body.find(r => r['repo_id'] === REPO_ID) as Record<string, unknown>;
    assert.equal(repo['repo_name'],         REPO_NAME);
    assert.equal(repo['repo_display_name'], REPO_DISPLAY_NAME);
    assert.equal(repo['latest_verdict'],    'BLOCKED');
    assert.ok('updated_at' in repo);
    assert.ok('db_key'     in repo);
  });
});

describe('GET /api/repos/:repoId/manifest', () => {
  it('returns the manifest JSON for a known repo', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/manifest`) as Record<string, unknown>;
    assert.equal(body['repo_id'],          REPO_ID);
    assert.equal(body['repo_name'],        REPO_NAME);
    assert.equal(body['latest_verdict'],   'BLOCKED');
    assert.equal(body['schema_version'],   1);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/manifest`);
    assert.equal(res.status, 404);
  });
});

// ── Per-repo data routes ──────────────────────────────────────────────────────

describe('GET /api/repos/:repoId/overview', () => {
  it('returns overview stats for the seeded repo', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/overview`) as Record<string, unknown>;
    assert.equal(body['totalRuns'],       1);
    assert.equal(body['failuresTriaged'], 2);
    assert.equal(body['clearRate'],       0);   // 0 CLEAR runs
    assert.equal(body['jirasCreated'],    1);   // 1 approved + executed_ok
    assert.equal(body['suppressionsSaved'], 1); // 1 history-based rejection
  });

  it('categoryBreakdown contains REGRESSION=2', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/overview`) as Record<string, unknown>;
    const cat  = body['categoryBreakdown'] as Record<string, number>;
    assert.equal(cat['REGRESSION'], 2);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/overview`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/repos/:repoId/runs/trend', () => {
  it('returns an array with at least one row', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/runs/trend`);
    assert.ok(Array.isArray(body));
    assert.ok((body as unknown[]).length > 0);
  });

  it('rows have day, verdict, count', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/runs/trend`) as Array<Record<string, unknown>>;
    const row  = body[0] as Record<string, unknown>;
    assert.ok('day'     in row);
    assert.ok('verdict' in row);
    assert.ok('count'   in row);
  });

  it('contains the seeded BLOCKED row', async () => {
    const body     = await getJson(`/api/repos/${REPO_ID}/runs/trend`) as Array<Record<string, unknown>>;
    const blocked  = body.find(r => r['verdict'] === 'BLOCKED');
    assert.ok(blocked !== undefined);
    assert.equal(blocked['count'], 1);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/runs/trend`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/repos/:repoId/failures/trend', () => {
  it('returns an array of failure category rows', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/failures/trend`) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    const row = body[0] as Record<string, unknown>;
    assert.ok('day'      in row);
    assert.ok('category' in row);
    assert.ok('count'    in row);
  });

  it('contains REGRESSION category', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/failures/trend`) as Array<Record<string, unknown>>;
    const reg  = body.find(r => r['category'] === 'REGRESSION');
    assert.ok(reg !== undefined);
    assert.equal(reg['count'], 2);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/failures/trend`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/repos/:repoId/failures/top', () => {
  it('returns an array', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/failures/top`);
    assert.ok(Array.isArray(body));
  });

  it('rows have test_name, error_hash, occurrences, last_seen', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/failures/top`) as Array<Record<string, unknown>>;
    assert.ok(body.length > 0);
    const row = body[0] as Record<string, unknown>;
    assert.ok('test_name'   in row);
    assert.ok('error_hash'  in row);
    assert.ok('occurrences' in row);
    assert.ok('last_seen'   in row);
  });

  it('respects ?limit=1', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/failures/top?limit=1`) as unknown[];
    assert.ok(body.length <= 1);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/failures/top`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/repos/:repoId/actions/trend', () => {
  it('returns an array', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/actions/trend`);
    assert.ok(Array.isArray(body));
  });

  it('contains create_jira rows from seeded data', async () => {
    const body  = await getJson(`/api/repos/${REPO_ID}/actions/trend`) as Array<Record<string, unknown>>;
    const jira  = body.find(r => r['action_type'] === 'create_jira');
    assert.ok(jira !== undefined, 'create_jira action type should appear');
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/actions/trend`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/repos/:repoId/actions/suppression', () => {
  it('returns suppression rows for history-based rejections', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/actions/suppression`) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0, 'suppression rows should be present');
    const first = body[0] as Record<string, unknown>;
    assert.ok('decision_reason' in first);
    assert.ok('count'           in first);
  });

  it('returns the seeded suppression with correct reason and count', async () => {
    const body   = await getJson(`/api/repos/${REPO_ID}/actions/suppression`) as Array<Record<string, unknown>>;
    const row    = body.find(r => r['decision_reason'] === 'history:jira_already_created');
    assert.ok(row !== undefined);
    assert.equal(row['count'], 1);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/actions/suppression`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/repos/:repoId/actions/verdict-summary', () => {
  it('returns an array', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/actions/verdict-summary`);
    assert.ok(Array.isArray(body));
  });

  it('rows have verdict and count', async () => {
    const body  = await getJson(`/api/repos/${REPO_ID}/actions/verdict-summary`) as Array<Record<string, unknown>>;
    assert.ok(body.length > 0);
    const first = body[0] as Record<string, unknown>;
    assert.ok('verdict' in first);
    assert.ok('count'   in first);
  });

  it('approved count = 1, rejected count = 1 from seeded data', async () => {
    const body     = await getJson(`/api/repos/${REPO_ID}/actions/verdict-summary`) as Array<Record<string, unknown>>;
    const approved = body.find(r => r['verdict'] === 'approved');
    const rejected = body.find(r => r['verdict'] === 'rejected');
    assert.ok(approved !== undefined);
    assert.equal(approved['count'], 1);
    assert.ok(rejected !== undefined);
    assert.equal(rejected['count'], 1);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/actions/verdict-summary`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/repos/:repoId/runs/recent', () => {
  it('returns an array', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/runs/recent`);
    assert.ok(Array.isArray(body));
  });

  it('rows have expected shape', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/runs/recent`) as Array<Record<string, unknown>>;
    assert.ok(body.length > 0);
    const row = body[0] as Record<string, unknown>;
    assert.ok('id'             in row);
    assert.ok('timestamp'      in row);
    assert.ok('pipeline_id'    in row);
    assert.ok('verdict'        in row);
    assert.ok('total_failures' in row);
    assert.ok('jiras_created'  in row);
    assert.ok('suppressions'   in row);
    assert.ok('actions_taken'  in row);
  });

  it('seeded run has correct counts', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/runs/recent`) as Array<Record<string, unknown>>;
    const run  = body[0] as Record<string, unknown>;
    assert.equal(run['verdict'],        'BLOCKED');
    assert.equal(run['total_failures'],  2);
    assert.equal(run['jiras_created'],   1);  // 1 approved + execution_ok=1
    assert.equal(run['suppressions'],    1);  // 1 history-based rejection
    assert.equal(run['actions_taken'],   2);  // approved + rejected
  });

  it('respects ?limit=1', async () => {
    const body = await getJson(`/api/repos/${REPO_ID}/runs/recent?limit=1`) as unknown[];
    assert.equal(body.length, 1);
  });

  it('returns 404 for an unknown repo', async () => {
    const res = await get(`/api/repos/${UNKNOWN_REPO_ID}/runs/recent`);
    assert.equal(res.status, 404);
  });
});

// ── Shell routes ──────────────────────────────────────────────────────────────

describe('GET /repos/:repoId (SPA shell)', () => {
  it('serves index.html with 200 when uiDist is valid', async () => {
    const res = await get(`/repos/${REPO_ID}`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('Oracle Dashboard'), 'should serve the fake index.html');
  });

  it('Content-Type is text/html', async () => {
    const res = await get(`/repos/${REPO_ID}`);
    assert.ok(res.headers.get('content-type')?.includes('text/html'));
  });
});

describe('GET /repos/:repoId/embed (SPA shell — embed path)', () => {
  it('serves index.html with 200', async () => {
    const res = await get(`/repos/${REPO_ID}/embed`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('Oracle Dashboard'));
  });
});

describe('Shell route — uiDist absent', () => {
  // Spin up a second server without passing uiDist
  let server2:  http.Server;
  let baseUrl2: string;

  before(async () => {
    const { createDashboardRouter } = await import('../src/dashboard-routes.js');
    const app = express();
    app.use(createDashboardRouter('', undefined)); // no uiDist
    await new Promise<void>(resolve => {
      server2 = app.listen(0, resolve);
    });
    const addr = server2.address() as { port: number };
    baseUrl2 = `http://localhost:${addr.port}`;
  });

  after(() => { server2?.close(); });

  it('returns 503 when uiDist is undefined', async () => {
    const res  = await fetch(`${baseUrl2}/repos/${REPO_ID}`);
    assert.equal(res.status, 503);
    const body = await res.json() as Record<string, unknown>;
    assert.ok(typeof body['error'] === 'string');
  });
});

// ── Cache-Control header ──────────────────────────────────────────────────────

describe('Cache-Control header on hosted API routes', () => {
  it('sets no-store on /api/repos/:repoId/overview', async () => {
    const res = await get(`/api/repos/${REPO_ID}/overview`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('sets no-store on /api/repos/:repoId/runs/recent', async () => {
    const res = await get(`/api/repos/${REPO_ID}/runs/recent`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('sets no-store on /api/repos (listing)', async () => {
    const res = await get('/api/repos');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});
