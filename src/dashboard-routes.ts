/**
 * Oracle Dashboard — API route handlers.
 *
 * createDashboardRouter(basePath) returns an Express Router that can be
 * mounted by dashboard-server.ts or imported directly by tests.
 *
 * In-memory TTL cache:
 *   DASHBOARD_CACHE_TTL — cache lifetime in seconds (default 30; set to 0 to disable)
 *
 * All routes are GET-only. Query params:
 *   start / end — ISO 8601 date strings (optional)
 *   limit       — integer, top-N query only (default 10)
 */

import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  getOverviewStats,
  getRunVerdictTrend,
  getFailureCategoryTrend,
  getActionTypeTrend,
  getTopRecurringFailures,
  getSuppressionSummary,
  getRecentRuns,
  getActionVerdictSummary,
  listReposFromSnapshotRoot,
} from './dashboard-queries.js';

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data:      unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cached<T>(key: string, fn: () => T): T {
  const ttlSec = parseInt(process.env['DASHBOARD_CACHE_TTL'] ?? '30', 10);
  if (ttlSec <= 0) return fn();

  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data as T;

  const data = fn();
  cache.set(key, { data, expiresAt: Date.now() + ttlSec * 1000 });
  return data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function noCache(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function dateParams(req: Request): { start?: string; end?: string } {
  const start = typeof req.query['start'] === 'string' ? req.query['start'] : undefined;
  const end   = typeof req.query['end']   === 'string' ? req.query['end']   : undefined;
  return { start, end };
}

function cacheKey(prefix: string, req: Request): string {
  const { start, end } = dateParams(req);
  return `${prefix}|${start ?? ''}|${end ?? ''}`;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * @param basePath  URL prefix for reverse-proxy deploys (default '').
 * @param uiDist    Absolute path to dashboard-ui/dist/.  Required for the
 *                  hosted-mode shell routes (/repos/:repoId and /repos/:repoId/embed)
 *                  to serve index.html.  When absent those routes return 503.
 *                  The server (dashboard-server.ts) computes this correctly and
 *                  passes it down; the router itself does not guess filesystem paths.
 */
export function createDashboardRouter(basePath = '', uiDist?: string): Router {
  const router = Router();
  const api    = `${basePath}/api/v1`;

  // Health check
  router.get(`${basePath}/healthz`, (_req, res) => {
    noCache(res);
    res.json({ ok: true, uptime: process.uptime(), db: 'connected' });
  });

  // Overview
  router.get(`${api}/overview`, (_req, res) => {
    noCache(res);
    try {
      const data = cached('overview', getOverviewStats);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Run verdict trend
  router.get(`${api}/runs/trend`, (req, res) => {
    noCache(res);
    try {
      const { start, end } = dateParams(req);
      const data = cached(cacheKey('runs/trend', req), () => getRunVerdictTrend(start, end));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Failures trend
  router.get(`${api}/failures/trend`, (req, res) => {
    noCache(res);
    try {
      const { start, end } = dateParams(req);
      const data = cached(cacheKey('failures/trend', req), () => getFailureCategoryTrend(start, end));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Top recurring failures
  router.get(`${api}/failures/top`, (req, res) => {
    noCache(res);
    try {
      const { start, end } = dateParams(req);
      const limit = parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '10', 10) || 10;
      const data  = cached(
        `${cacheKey('failures/top', req)}|${limit}`,
        () => getTopRecurringFailures(start, end, limit),
      );
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Action type trend
  router.get(`${api}/actions/trend`, (req, res) => {
    noCache(res);
    try {
      const { start, end } = dateParams(req);
      const data = cached(cacheKey('actions/trend', req), () => getActionTypeTrend(start, end));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Suppression summary
  router.get(`${api}/actions/suppression`, (req, res) => {
    noCache(res);
    try {
      const { start, end } = dateParams(req);
      const data = cached(cacheKey('actions/suppression', req), () => getSuppressionSummary(start, end));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Action verdict summary (approved / rejected / held / deferred counts)
  router.get(`${api}/actions/verdict-summary`, (_req, res) => {
    noCache(res);
    try {
      const data = cached('actions/verdict-summary', getActionVerdictSummary);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Recent runs (latest N, with per-run action counts)
  router.get(`${api}/runs/recent`, (req, res) => {
    noCache(res);
    try {
      const limit = parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '10', 10) || 10;
      const data  = cached(`runs/recent|${limit}`, () => getRecentRuns(limit));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Hosted-mode: repo-scoped routes (requires ORACLE_SNAPSHOT_ROOT) ──────
  //
  // When ORACLE_SNAPSHOT_ROOT is set, the full /api/v1/* surface is mirrored
  // under /api/repos/:repoId/* so the existing dashboard pages work unchanged
  // against per-repo snapshot DBs.  buildBase() in the frontend routes to the
  // correct prefix automatically.

  const SNAPSHOT_ROOT = process.env['ORACLE_SNAPSHOT_ROOT'];

  if (SNAPSHOT_ROOT) {
    // Open a read-only connection to a repo's snapshot DB.
    // Returns null if the snapshot does not exist yet.
    function openRepoDb(repoId: string): Database.Database | null {
      const dbPath = path.join(SNAPSHOT_ROOT!, 'repos', repoId, 'latest.db');
      if (!existsSync(dbPath)) return null;
      const db = new Database(dbPath, { readonly: true });
      // WAL reader — no PRAGMA journal_mode change needed on a readonly handle
      return db;
    }

    // Execute fn with a repo DB; handles 404 / 500 and always closes the DB.
    function withRepoDb<T>(
      repoId: string,
      res:    Response,
      fn:     (db: Database.Database) => T,
    ): void {
      const db = openRepoDb(repoId);
      if (!db) { res.status(404).json({ error: 'repo not found' }); return; }
      try {
        res.json(fn(db));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      } finally {
        db.close();
      }
    }

    // ── Meta ──────────────────────────────────────────────────────────────────

    // List all repos in the snapshot root
    router.get(`${basePath}/api/repos`, (_req, res) => {
      noCache(res);
      try { res.json(listReposFromSnapshotRoot(SNAPSHOT_ROOT)); }
      catch (err) { res.status(500).json({ error: String(err) }); }
    });

    // Per-repo manifest
    router.get(`${basePath}/api/repos/:repoId/manifest`, (req, res) => {
      noCache(res);
      const manifestPath = path.join(SNAPSHOT_ROOT!, 'repos', req.params['repoId']!, 'manifest.json');
      if (!existsSync(manifestPath)) { res.status(404).json({ error: 'repo not found' }); return; }
      try { res.json(JSON.parse(readFileSync(manifestPath, 'utf8'))); }
      catch (err) { res.status(500).json({ error: String(err) }); }
    });

    // ── Full API surface mirrored under /api/repos/:repoId/* ─────────────────
    // Route names deliberately match the /api/v1/* paths so buildBase() in
    // api.ts can switch prefix without changing any individual path segment.

    router.get(`${basePath}/api/repos/:repoId/overview`, (req, res) => {
      noCache(res);
      withRepoDb(req.params['repoId']!, res, db => getOverviewStats(db));
    });

    router.get(`${basePath}/api/repos/:repoId/runs/trend`, (req, res) => {
      noCache(res);
      const { start, end } = dateParams(req);
      withRepoDb(req.params['repoId']!, res, db => getRunVerdictTrend(start, end, db));
    });

    router.get(`${basePath}/api/repos/:repoId/failures/trend`, (req, res) => {
      noCache(res);
      const { start, end } = dateParams(req);
      withRepoDb(req.params['repoId']!, res, db => getFailureCategoryTrend(start, end, db));
    });

    router.get(`${basePath}/api/repos/:repoId/failures/top`, (req, res) => {
      noCache(res);
      const { start, end } = dateParams(req);
      const limit = parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '10', 10) || 10;
      withRepoDb(req.params['repoId']!, res, db => getTopRecurringFailures(start, end, limit, db));
    });

    router.get(`${basePath}/api/repos/:repoId/actions/trend`, (req, res) => {
      noCache(res);
      const { start, end } = dateParams(req);
      withRepoDb(req.params['repoId']!, res, db => getActionTypeTrend(start, end, db));
    });

    router.get(`${basePath}/api/repos/:repoId/actions/suppression`, (req, res) => {
      noCache(res);
      const { start, end } = dateParams(req);
      withRepoDb(req.params['repoId']!, res, db => getSuppressionSummary(start, end, db));
    });

    router.get(`${basePath}/api/repos/:repoId/actions/verdict-summary`, (_req, res) => {
      noCache(res);
      withRepoDb(_req.params['repoId']!, res, db => getActionVerdictSummary(db));
    });

    router.get(`${basePath}/api/repos/:repoId/runs/recent`, (req, res) => {
      noCache(res);
      const limit = parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '10', 10) || 10;
      withRepoDb(req.params['repoId']!, res, db => getRecentRuns(limit, db));
    });

    // ── SPA shell for repo-scoped pages ───────────────────────────────────────
    // Serve index.html for both /repos/:repoId and /repos/:repoId/embed.
    // The frontend reads repoId from window.location.pathname and sets embed
    // mode from the path suffix (endsWith('/embed')) or ?embed=true.

    function serveShell(_req: Request, res: Response): void {
      if (uiDist && existsSync(uiDist)) {
        res.sendFile(path.join(uiDist, 'index.html'));
      } else {
        res.status(503).json({ error: 'dashboard UI not built — run npm run dashboard:build' });
      }
    }

    router.get(`${basePath}/repos/:repoId`,       serveShell);
    router.get(`${basePath}/repos/:repoId/embed`,  serveShell);
  }

  return router;
}
