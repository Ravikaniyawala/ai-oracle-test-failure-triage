/**
 * Integration tests for dashboard API routes.
 *
 * Spins up an Express server on a random port using createDashboardRouter(),
 * uses a real in-memory SQLite DB seeded with known data, and verifies
 * the HTTP responses.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';

// We need to intercept getDb() before importing dashboard-routes.
// Use a module-level mock by patching the state-store module.
// Since this is ESM, we seed via initDb() with a temp DB path.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── Seed helper ───────────────────────────────────────────────────────────────

function seedDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      pipeline_id TEXT NOT NULL,
      total_failures INTEGER NOT NULL,
      categories_json TEXT NOT NULL,
      verdict TEXT NOT NULL DEFAULT 'BLOCKED'
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

  db.prepare(`INSERT INTO runs (timestamp, pipeline_id, total_failures, categories_json, verdict) VALUES (?, ?, ?, ?, ?)`)
    .run('2026-04-01T10:00:00.000Z', 'pipe-1', 2, '{"FLAKY":2}', 'BLOCKED');
  db.prepare(`INSERT INTO runs (timestamp, pipeline_id, total_failures, categories_json, verdict) VALUES (?, ?, ?, ?, ?)`)
    .run('2026-04-02T10:00:00.000Z', 'pipe-2', 0, '{}', 'CLEAR');

  db.prepare(`INSERT INTO failures (run_id, test_name, error_hash, category, confidence) VALUES (?, ?, ?, ?, ?)`)
    .run(1, 'test A', 'abc123', 'FLAKY', 0.9);
  db.prepare(`INSERT INTO failures (run_id, test_name, error_hash, category, confidence) VALUES (?, ?, ?, ?, ?)`)
    .run(1, 'test B', 'def456', 'FLAKY', 0.8);

  db.prepare(`INSERT INTO actions (run_id, scope, action_type, action_fingerprint, source, verdict, decision_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(1, 'run', 'create_jira', 'fp-001', 'policy', 'rejected', 'history:jira_already_created', '2026-04-01T10:00:00.000Z');

  db.close();
}

// ── Test setup ────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let tmpDir: string;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`);
  return res.json();
}


before(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'oracle-dashboard-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  seedDb(dbPath);

  // Point state-store at our test DB
  process.env['ORACLE_STATE_DB_PATH'] = dbPath;

  // Dynamically import after env is set
  const { initDb } = await import('../src/state-store.js');
  const { createDashboardRouter } = await import('../src/dashboard-routes.js');

  initDb();

  const app = express();
  app.use(createDashboardRouter(''));

  await new Promise<void>(resolve => {
    server = app.listen(0, resolve);
  });

  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

after(() => {
  server?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /healthz', () => {
  it('returns ok=true', async () => {
    const body = await getJson('/healthz') as Record<string, unknown>;
    assert.equal(body['ok'], true);
    assert.equal(body['db'], 'connected');
    assert.equal(typeof body['uptime'], 'number');
  });
});

describe('GET /api/v1/overview', () => {
  it('returns correct totalRuns', async () => {
    const body = await getJson('/api/v1/overview') as Record<string, unknown>;
    assert.equal(body['totalRuns'], 2);
  });

  it('returns clearRate of 0.5', async () => {
    const body = await getJson('/api/v1/overview') as Record<string, unknown>;
    assert.equal(body['clearRate'], 0.5);
  });

  it('returns failuresTriaged = 2', async () => {
    const body = await getJson('/api/v1/overview') as Record<string, unknown>;
    assert.equal(body['failuresTriaged'], 2);
  });

  it('returns jirasCreated = 0 (none executed ok in seed)', async () => {
    const body = await getJson('/api/v1/overview') as Record<string, unknown>;
    assert.equal(body['jirasCreated'], 0);
  });

  it('returns suppressionsSaved = 1', async () => {
    const body = await getJson('/api/v1/overview') as Record<string, unknown>;
    assert.equal(body['suppressionsSaved'], 1);
  });

  it('returns categoryBreakdown with FLAKY=2', async () => {
    const body = await getJson('/api/v1/overview') as Record<string, unknown>;
    const cat  = body['categoryBreakdown'] as Record<string, number>;
    assert.equal(cat['FLAKY'], 2);
  });
});

describe('GET /api/v1/runs/trend', () => {
  it('returns an array', async () => {
    const body = await getJson('/api/v1/runs/trend');
    assert.ok(Array.isArray(body));
  });

  it('contains CLEAR and BLOCKED rows', async () => {
    const body = await getJson('/api/v1/runs/trend') as Array<Record<string, unknown>>;
    const verdicts = body.map(r => r['verdict']);
    assert.ok(verdicts.includes('CLEAR'));
    assert.ok(verdicts.includes('BLOCKED'));
  });
});

describe('GET /api/v1/failures/trend', () => {
  it('returns array of failure category rows', async () => {
    const body = await getJson('/api/v1/failures/trend') as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    const first = body[0] ?? {};
    assert.ok('day' in first);
    assert.ok('category' in first);
    assert.ok('count' in first);
  });
});

describe('GET /api/v1/failures/top', () => {
  it('returns up to default 10 rows', async () => {
    const body = await getJson('/api/v1/failures/top') as Array<unknown>;
    assert.ok(Array.isArray(body));
    assert.ok(body.length <= 10);
  });

  it('respects limit param', async () => {
    const body = await getJson('/api/v1/failures/top?limit=1') as Array<unknown>;
    assert.ok(body.length <= 1);
  });

  it('rows have test_name, error_hash, occurrences, last_seen', async () => {
    const body = await getJson('/api/v1/failures/top') as Array<Record<string, unknown>>;
    assert.ok(body.length > 0);
    const row = body[0] ?? {};
    assert.ok('test_name'   in row);
    assert.ok('error_hash'  in row);
    assert.ok('occurrences' in row);
    assert.ok('last_seen'   in row);
  });
});

describe('GET /api/v1/actions/trend', () => {
  it('returns array', async () => {
    const body = await getJson('/api/v1/actions/trend');
    assert.ok(Array.isArray(body));
  });
});

describe('GET /api/v1/actions/suppression', () => {
  it('returns suppression rows', async () => {
    const body = await getJson('/api/v1/actions/suppression') as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(body));
    assert.ok(body.length > 0);
    const first = body[0] ?? {};
    assert.ok('decision_reason' in first);
    assert.ok('count' in first);
  });
});

describe('GET /api/v1/runs/recent', () => {
  it('returns an array', async () => {
    const body = await getJson('/api/v1/runs/recent');
    assert.ok(Array.isArray(body));
  });

  it('rows have expected shape', async () => {
    const body = await getJson('/api/v1/runs/recent') as Array<Record<string, unknown>>;
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

  it('returns most recent run first (highest id)', async () => {
    const body = await getJson('/api/v1/runs/recent') as Array<Record<string, unknown>>;
    assert.ok(body.length >= 2);
    const first  = body[0] as Record<string, unknown>;
    const second = body[1] as Record<string, unknown>;
    assert.ok((first['id'] as number) > (second['id'] as number));
  });

  it('respects limit param', async () => {
    const body = await getJson('/api/v1/runs/recent?limit=1') as Array<unknown>;
    assert.equal(body.length, 1);
  });

  it('suppressions count matches seeded data', async () => {
    const body = await getJson('/api/v1/runs/recent') as Array<Record<string, unknown>>;
    // run 1 has 1 history-based rejection
    const run1 = body.find(r => r['id'] === 1) as Record<string, unknown> | undefined;
    assert.ok(run1 !== undefined);
    assert.equal(run1['suppressions'], 1);
  });
});

describe('GET /api/v1/actions/verdict-summary', () => {
  it('returns an array', async () => {
    const body = await getJson('/api/v1/actions/verdict-summary');
    assert.ok(Array.isArray(body));
  });

  it('rows have verdict and count', async () => {
    const body = await getJson('/api/v1/actions/verdict-summary') as Array<Record<string, unknown>>;
    assert.ok(body.length > 0);
    const first = body[0] as Record<string, unknown>;
    assert.ok('verdict' in first);
    assert.ok('count'   in first);
  });

  it('rejected count = 1 (from seeded data)', async () => {
    const body = await getJson('/api/v1/actions/verdict-summary') as Array<Record<string, unknown>>;
    const rejected = body.find(r => r['verdict'] === 'rejected');
    assert.ok(rejected !== undefined);
    assert.equal(rejected['count'], 1);
  });
});

describe('Cache-Control header', () => {
  it('sets no-store on all API responses', async () => {
    const res = await fetch(`${baseUrl}/api/v1/overview`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

