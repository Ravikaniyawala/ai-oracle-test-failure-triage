# Oracle Dashboard V1 — Architecture Plan

> Status: Planning  
> Branch: feature/dashboard-v1  
> Phase 1 scope: Overview · Failures · Actions

---

## 1. Findings from current codebase

### What already exists and is reusable

| Asset | Location | Dashboard relevance |
|---|---|---|
| 5 read-only query helpers | `src/dashboard-queries.ts` | Direct data source for all 3 tabs |
| `getDb()` export | `src/state-store.ts` | Needed by the query helpers; no extra DB setup |
| `ORACLE_STATE_DB_PATH` env var | `src/state-store.ts:14` | Already the canonical DB path — reuse as-is |
| `runs.verdict` column | `state-store.ts` schema | Powers Overview clear-rate and verdict trend |
| `actions.created_at` column | `state-store.ts` schema | Powers time-series action queries |
| TypeScript strict ESM | `tsconfig.json` | Server code can share types with UI via a shared types package or inline copy |
| `TriageCategory` enum | `src/types.ts` | Directly usable in UI for colour coding |
| 5 dashboard result interfaces | `src/types.ts` | Define the API contract between server and UI |

### Constraints from the existing stack

- **Module format**: `"module": "NodeNext"` — all `src/` files use ESM `.js` extensions. The API server will follow the same pattern.
- **better-sqlite3 is synchronous** — queries are blocking. Acceptable for a local tool and small team Confluence embed; see Risks section.
- **No web framework exists yet** — Express or Fastify must be added.
- **No frontend build tooling exists yet** — Vite must be added.
- **tsconfig rootDir is `.`** — the UI build must use its own `vite.config.ts`; it does not participate in the backend TypeScript compilation.

---

## 2. Recommended architecture

### Choice: Express API server + React/Vite static frontend, single process

```
┌─────────────────────────────────────────────────────────┐
│  Node.js process  (src/dashboard-server.ts)             │
│                                                         │
│  ┌────────────────────────┐  ┌───────────────────────┐ │
│  │  Express API           │  │  Static file serving  │ │
│  │  /api/v1/*             │  │  dashboard-ui/dist/   │ │
│  │  src/dashboard-routes  │  │  (built by Vite)      │ │
│  └────────────┬───────────┘  └───────────────────────┘ │
│               │                                         │
│  ┌────────────▼───────────────────────────────────────┐ │
│  │  src/dashboard-queries.ts (existing, unchanged)    │ │
│  └────────────┬───────────────────────────────────────┘ │
│               │                                         │
│  ┌────────────▼───────────────────────────────────────┐ │
│  │  SQLite  (ORACLE_STATE_DB_PATH)   read-only        │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### Why this choice

| Criterion | Rationale |
|---|---|
| **Low complexity** | One process, one port, one command. No reverse proxy, no Docker required for local dev. |
| **Local run** | `npm run dashboard` builds the UI and starts the server. Done. |
| **Confluence embedding** | A deployed instance of the same server is iframeable. `?embed=true` strips nav chrome. |
| **SQLite-backed** | Express route handlers call existing `dashboard-queries.ts` directly — no ORM, no connection pool. |
| **Read-only** | Only GET routes. No state-mutating endpoints. |
| **Phase 2/3 evolution** | Adding new tabs = new API route + new React page. No architecture change required. |
| **Shared types** | The 5 dashboard result interfaces in `src/types.ts` are the API contract. UI consumes them as-is via a shared type import or JSON-inferred types. |

### Why not alternatives

| Alternative | Why rejected |
|---|---|
| Server-rendered HTML (no React) | Harder to add interactive charts, filters, date pickers in Phase 2. More re-work later. |
| Static HTML + external API | Requires CORS config, separate deploy units, and complicates Confluence embedding. |
| Next.js / Remix | Heavyweight for a read-only internal tool. Adds significant build complexity. |
| Vanilla JS (no framework) | Fine for Phase 1 but becomes maintenance burden when Phase 2 adds filters and charts. |
| Separate repo | Unnecessary split for an internal tool; harder to keep DB query types in sync. |

---

## 3. Proposed folder and file structure

```
ai-oracle-triage/
├── src/
│   ├── dashboard-server.ts      ← NEW: Express entry point
│   ├── dashboard-routes.ts      ← NEW: /api/v1/* handlers
│   ├── dashboard-queries.ts     ← existing (unchanged)
│   ├── state-store.ts           ← existing (unchanged)
│   └── types.ts                 ← existing + dashboard result types (already added)
│
├── dashboard-ui/                ← NEW: Vite + React frontend
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx              ← tab routing, embed mode, layout
│       ├── api.ts               ← typed fetch wrappers for /api/v1/*
│       ├── types.ts             ← copy of dashboard result interfaces (or import from shared)
│       ├── pages/
│       │   ├── OverviewPage.tsx
│       │   ├── FailuresPage.tsx
│       │   └── ActionsPage.tsx
│       └── components/
│           ├── StatCard.tsx
│           ├── TrendChart.tsx   ← recharts or Chart.js wrapper
│           └── DataTable.tsx
│
└── docs/
    └── dashboard-v1-plan.md     ← this file
```

### Key design decisions on structure

- `dashboard-ui/` has its **own `tsconfig.json`** and is built by Vite independently. It does not participate in the backend `tsc` build.
- `dashboard-ui/src/api.ts` contains all `fetch()` calls — the UI never imports from `src/` directly (no Node.js deps in the browser bundle).
- The dashboard result types (`RunVerdictTrendRow` etc.) are small value objects. In Phase 1, duplicate them in `dashboard-ui/src/types.ts`. If the interface changes frequently, consider a `shared/` package in Phase 2.

---

## 4. Phase 1 API routes and page contract

### Server routes

```
GET /health
  → 200 { ok: true, uptime: <seconds>, db: 'connected' }

GET /api/v1/overview
  → {
      totalRuns:         number,   // runs table COUNT(*)
      clearRate:         number,   // % of CLEAR runs (0–1)
      totalFailures:     number,   // failures table COUNT(*)
      suppressionsSaved: number,   // history-based rejected actions COUNT(*)
      categoryBreakdown: { FLAKY, REGRESSION, ENV_ISSUE, NEW_BUG }
    }

GET /api/v1/runs/trend?start=&end=
  → RunVerdictTrendRow[]
     [ { day: 'YYYY-MM-DD', verdict: 'CLEAR'|'BLOCKED', count: number }, … ]

GET /api/v1/failures/trend?start=&end=
  → FailureCategoryTrendRow[]
     [ { day, category, count }, … ]

GET /api/v1/failures/top?start=&end=&limit=10
  → RecurringFailureRow[]
     [ { test_name, error_hash, occurrences, last_seen }, … ]

GET /api/v1/actions/trend?start=&end=
  → ActionTypeTrendRow[]
     [ { day, action_type, verdict, count }, … ]

GET /api/v1/actions/suppression?start=&end=
  → SuppressionSummaryRow[]
     [ { decision_reason, count }, … ]
```

All routes are GET-only. `start` and `end` are ISO 8601 strings (optional). The server passes them directly to the existing query helper functions.

### Frontend pages

| Page | URL | Data sources |
|---|---|---|
| Overview | `/` or `/?tab=overview` | `/api/v1/overview`, `/api/v1/runs/trend` |
| Failures | `/?tab=failures` | `/api/v1/failures/trend`, `/api/v1/failures/top` |
| Actions | `/?tab=actions` | `/api/v1/actions/trend`, `/api/v1/actions/suppression` |

Tab state lives in the URL (`?tab=`) so Confluence can link to a specific tab directly. React Router is not needed — a simple `URLSearchParams` + state approach keeps the bundle small.

---

## 5. Local run plan

### npm scripts

```jsonc
// package.json additions
"dashboard":          "npm run dashboard:build && node dist/src/dashboard-server.js",
"dashboard:dev":      "tsx src/dashboard-server.ts",
"dashboard:build":    "vite build dashboard-ui --outDir ../dashboard-ui/dist",
"dashboard:ui":       "vite dev dashboard-ui"
```

For local development (two terminals):

```bash
# Terminal 1 — API server with hot reload
npm run dashboard:dev

# Terminal 2 — Vite dev server with proxy to API
npm run dashboard:ui
# → opens http://localhost:5173
# → proxies /api/* to http://localhost:3000
```

For a single-command production-like run:

```bash
npm run dashboard
# → builds dashboard-ui/dist/
# → starts Express on DASHBOARD_PORT (default 3000)
# → serves static files from dashboard-ui/dist/
# → opens http://localhost:3000
```

### Environment variables for local mode

| Variable | Default | Purpose |
|---|---|---|
| `ORACLE_STATE_DB_PATH` | `./oracle-state.db` | Path to SQLite DB (existing) |
| `DASHBOARD_PORT` | `3000` | Port for Express server |
| `DASHBOARD_ALLOWED_ORIGINS` | _(unset)_ | Comma-separated origins for CSP frame-ancestors |

---

## 6. Confluence embed plan

### How it works

1. The dashboard is deployed to an **internal host** reachable from Confluence (e.g. `http://oracle-dashboard.internal:3000`).
2. A Confluence page uses the **IFrame macro** (or HTML macro) pointing at:
   ```
   http://oracle-dashboard.internal:3000/?tab=overview&embed=true
   ```
3. The React app reads `?embed=true` on mount and:
   - Hides the top header/brand bar
   - Keeps the tab navigation (still useful inside the iframe)
   - Uses compact spacing (designed for ~1200px iframe width)

### Server-side changes for iframe safety

In `dashboard-server.ts`, when `DASHBOARD_ALLOWED_ORIGINS` is set:

```ts
// Set CSP frame-ancestors to allowlist Confluence domains
res.setHeader(
  'Content-Security-Policy',
  `frame-ancestors 'self' ${allowedOrigins}`
);
// Remove X-Frame-Options so CSP takes precedence
res.removeHeader('X-Frame-Options');
```

When `DASHBOARD_ALLOWED_ORIGINS` is not set (local dev), no framing headers are set — iframing works from anywhere, which is fine for localhost.

### Confluence-specific URL patterns

| Use case | URL |
|---|---|
| Full dashboard (Confluence overview page) | `http://host:3000/?embed=true` |
| Failures tab only (Confluence failures page) | `http://host:3000/?tab=failures&embed=true` |
| Actions tab only (Confluence actions page) | `http://host:3000/?tab=actions&embed=true` |

### Iframe sizing recommendation

```html
<!-- Confluence HTML macro -->
<iframe
  src="http://oracle-dashboard.internal:3000/?embed=true"
  width="100%"
  height="700"
  frameborder="0"
  scrolling="auto"
></iframe>
```

The dashboard should be designed mobile-first at 1200px max-width so it fits within Confluence's content area without horizontal scroll.

### Constraints to be aware of

- **Confluence Cloud** (Atlassian-hosted) requires the iframed URL to use **HTTPS**. A TLS-terminating reverse proxy (nginx, Caddy) in front of the Node server handles this for <$0.
- **Confluence Server/Data Center** (self-hosted) is more flexible — HTTP is generally acceptable on the internal network.
- The `ALLOW-FROM` value of `X-Frame-Options` is deprecated in Chrome and Firefox. Use `Content-Security-Policy: frame-ancestors` instead.
- Some Confluence Cloud admin configurations block all custom iframes by default — allowlisting the dashboard domain in the Confluence admin panel may be required.

---

## 7. Implementation roadmap

### Step 1 — Server skeleton (≈2 hours)
- Add `express` + `@types/express` to `package.json`
- Create `src/dashboard-server.ts`:
  - Reads `ORACLE_STATE_DB_PATH`, calls `initDb()`
  - Mounts API routes from `dashboard-routes.ts`
  - Serves `dashboard-ui/dist/` as static files
  - Listens on `DASHBOARD_PORT`
- Create `src/dashboard-routes.ts`:
  - `GET /health`
  - `GET /api/v1/overview` (derive from existing queries)
  - `GET /api/v1/runs/trend`
  - `GET /api/v1/failures/trend`
  - `GET /api/v1/failures/top`
  - `GET /api/v1/actions/trend`
  - `GET /api/v1/actions/suppression`
- Add `dashboard:dev` script

### Step 2 — Vite + React scaffold (≈1 hour)
- `npm create vite@latest dashboard-ui -- --template react-ts`
- Configure `vite.config.ts` with proxy:
  ```ts
  proxy: { '/api': 'http://localhost:3000' }
  ```
- Add `dashboard:ui` and `dashboard:build` scripts
- Stub `App.tsx` with three tab buttons

### Step 3 — Overview page (≈3 hours)
- Fetch `/api/v1/overview` → 4 `StatCard` components (total runs, clear rate, total failures, suppressions saved)
- Fetch `/api/v1/runs/trend` → simple bar or line chart (recharts, ~30kb gzipped)
- Embed mode: hide header

### Step 4 — Failures page (≈3 hours)
- Fetch `/api/v1/failures/trend` → stacked bar chart by category with colour coding from `TriageCategory`
- Fetch `/api/v1/failures/top` → `DataTable` component (sortable columns, last_seen formatting)

### Step 5 — Actions page (≈2 hours)
- Fetch `/api/v1/actions/trend` → bar chart grouped by `action_type`, coloured by `verdict`
- Fetch `/api/v1/actions/suppression` → small summary table showing Oracle's noise savings

### Step 6 — Embed mode + Confluence headers (≈1 hour)
- `?embed=true` detection in `App.tsx`
- `DASHBOARD_ALLOWED_ORIGINS` env var → `Content-Security-Policy: frame-ancestors`
- Responsive layout at 1200px max-width

### Step 7 — Build + docs (≈1 hour)
- `npm run dashboard` one-command build + serve
- README section: "Running the dashboard"
- Environment variable documentation

---

## 8. Risks and trade-offs

### better-sqlite3 is synchronous

The query helpers are synchronous. Under concurrent dashboard requests (multiple team members hitting the Confluence embed simultaneously), slow queries will block the Node event loop. For Phase 1 with 5–10 concurrent viewers and lightweight queries this is fine. If it becomes an issue in Phase 2, add in-memory query result caching (a `Map` with TTL) in `dashboard-routes.ts` — no architectural change required.

### Vite proxy only works in dev mode

When running `npm run dashboard` (production build served by Express), the Vite proxy is not in play — the API and UI are both served from the same Express process. This is correct. The dev mode (`dashboard:dev` + `dashboard:ui`) uses the proxy. Keep these two modes consistent by always prefixing API calls with `/api/v1/` in the UI code.

### Confluence Cloud iframe allowlisting

Atlassian Cloud Confluence may require an admin to explicitly allowlist the dashboard URL. This is a configuration step, not a code problem. Document it.

### Type duplication between server and UI

`dashboard-ui/src/types.ts` will be a copy of the 5 dashboard result interfaces from `src/types.ts`. In Phase 1 this is a 30-line copy — acceptable. If the interfaces change frequently, extract a `shared/types.ts` and configure Vite's `resolve.alias` to point at it. Do not do this prematurely.

### No pagination in Phase 1

`getTopRecurringFailures()` defaults to 10 rows, `getActionTypeTrend()` returns all rows. For large DBs (thousands of runs), this could become slow. Add `?limit=` and `?offset=` query params in Phase 2. In Phase 1, the default limit of 10 is safe.

### `?tab=` vs React Router

Using URL search params for tab state is simpler than React Router and avoids a dependency. The trade-off is that deep linking is limited to tab level — individual failure records can't have their own URL. This is acceptable for Phase 1's read-only tabular design. Add React Router in Phase 2 if drill-down views are needed.

---

## Phase 2 / Phase 3 compatibility

The chosen architecture supports all likely future additions without structural change:

| Future metric | How to add |
|---|---|
| Agent proposals tab | New API route + new React page |
| Confidence / validation health | New API route calling `agent_proposals` table |
| Pipeline / branch filters | Add `?pipeline=` query param to API routes; pass to existing query helpers |
| Date range picker | Already supported — API routes accept `start` / `end` |
| Release readiness score | Derived query in `dashboard-routes.ts`, no schema change |
| Flakiness heatmap | New `dashboard-queries.ts` function + new page |
| Top noise saved | Already in `getSuppressionSummary()` |
