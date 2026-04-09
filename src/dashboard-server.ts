/**
 * Oracle Dashboard — Express entry point.
 *
 * Serves the React/Vite static frontend from dashboard-ui/dist/ and
 * mounts the API router at <basePath>/api/v1/*.
 *
 * Environment variables:
 *   ORACLE_STATE_DB_PATH      — SQLite DB path (default ./oracle-state.db)
 *   DASHBOARD_PORT            — HTTP port (default 3000)
 *   DASHBOARD_BASE_PATH       — URL prefix for reverse-proxy deploys (default '')
 *   DASHBOARD_FRAME_ANCESTORS — CSP frame-ancestors value for Confluence embedding
 */

import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initDb } from './state-store.js';
import { createDashboardRouter } from './dashboard-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT      = parseInt(process.env['DASHBOARD_PORT'] ?? '3000', 10);
const BASE_PATH = (process.env['DASHBOARD_BASE_PATH'] ?? '').replace(/\/$/, '');
const FRAME_ANCESTORS = process.env['DASHBOARD_FRAME_ANCESTORS'];

// Resolve the UI dist directory — works for both:
//   tsx src/dashboard-server.ts  → __dirname = src/
//   node dist/src/dashboard-server.js → __dirname = dist/src/
const UI_DIST = path.resolve(__dirname, '../../dashboard-ui/dist');

initDb();

const app = express();

// ── Security headers ──────────────────────────────────────────────────────────

app.use((_req, res, next) => {
  if (FRAME_ANCESTORS) {
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${FRAME_ANCESTORS}`);
    res.removeHeader('X-Frame-Options');
  }
  next();
});

// ── API routes ────────────────────────────────────────────────────────────────

const router = createDashboardRouter(BASE_PATH);
app.use(BASE_PATH || '/', router);

// ── Static frontend ───────────────────────────────────────────────────────────

if (existsSync(UI_DIST)) {
  app.use(BASE_PATH || '/', express.static(UI_DIST));
  // SPA fallback — send index.html for all non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith(`${BASE_PATH}/api`) || req.path === `${BASE_PATH}/healthz`) {
      return next();
    }
    res.sendFile(path.join(UI_DIST, 'index.html'));
  });
} else {
  console.warn('[oracle:dashboard-server] UI dist not found at', UI_DIST, '— run npm run dashboard:build first');
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[oracle:dashboard-server] listening on http://localhost:${PORT}${BASE_PATH || '/'}`);
});

export { app };
