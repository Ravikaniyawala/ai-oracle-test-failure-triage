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
import {
  getOverviewStats,
  getRunVerdictTrend,
  getFailureCategoryTrend,
  getActionTypeTrend,
  getTopRecurringFailures,
  getSuppressionSummary,
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

export function createDashboardRouter(basePath = ''): Router {
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

  return router;
}
