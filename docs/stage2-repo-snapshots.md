# Stage 2 — Repo-Scoped Snapshots

## Purpose

Stage 2 adds durable, repo-scoped snapshot artifacts to the Oracle triage pipeline. After every triage run, Oracle writes a compact set of files to a configurable snapshot directory. These files can be uploaded to artifact storage (e.g. GitHub Actions artifacts, S3, GCS) and read by a hosted dashboard that aggregates data across multiple repositories.

Stage 1 supported a single-repo mode: one SQLite DB, one dashboard. Stage 2 extends that to a hosted mode where a single dashboard server can serve data for many repos simultaneously, each backed by its own `latest.db` snapshot and `manifest.json`.

---

## Repo identity

Every snapshot is tagged with three identity fields:

| Field             | Purpose                                             |
|-------------------|-----------------------------------------------------|
| `repo_id`         | Stable numeric ID. Does not change on repo rename.  |
| `repo_name`       | `owner/repo` slug. Human-readable, renameable.      |
| `repo_display_name` | Short label shown in the dashboard header.        |

### Resolution priority

1. **ORACLE_REPO_* env vars** — explicit operator overrides (highest priority).
2. **GitHub Actions built-in vars** — `GITHUB_REPOSITORY_ID`, `GITHUB_REPOSITORY`.
3. **null** — identity unavailable; snapshot export is skipped silently.

| Env var                    | Fallback                        |
|----------------------------|---------------------------------|
| `ORACLE_REPO_ID`           | `GITHUB_REPOSITORY_ID`          |
| `ORACLE_REPO_NAME`         | `GITHUB_REPOSITORY`             |
| `ORACLE_REPO_DISPLAY_NAME` | last segment of `repo_name` after `/` |

If only `ORACLE_REPO_ID` is set, `repo_name` and `repo_display_name` both fall back to the repo ID value.

---

## Snapshot layout

All snapshots are written under `ORACLE_SNAPSHOT_ROOT` (default: `./oracle-snapshots`).

```
{snapshotRoot}/
  repos/
    {repo_id}/
      manifest.json         ← overwritten on every run
      latest.db             ← copy of oracle-state.db at run completion
      events/
        {run_id}.json       ← one file per triage run (never overwritten)
```

---

## Artifact schemas

### `manifest.json`

Written after every run. Always reflects the most recent run.

```json
{
  "schema_version":    1,
  "repo_id":           "123456789",
  "repo_name":         "my-org/my-service",
  "repo_display_name": "my-service",
  "updated_at":        "2026-04-12T10:00:00.000Z",
  "latest_run_id":     "9876543210",
  "latest_verdict":    "BLOCKED",
  "db_key":            "repos/123456789/latest.db"
}
```

Fields:

| Field               | Type   | Description                                       |
|---------------------|--------|---------------------------------------------------|
| `schema_version`    | int    | Always `1` for this stage                        |
| `repo_id`           | string | Stable repo identifier                            |
| `repo_name`         | string | `owner/repo` slug                                 |
| `repo_display_name` | string | Short label for UI                                |
| `updated_at`        | string | ISO 8601 timestamp of the run that wrote this     |
| `latest_run_id`     | string | Pipeline/run ID of the most recent run            |
| `latest_verdict`    | string | `CLEAR` or `BLOCKED`                              |
| `db_key`            | string | Relative path to `latest.db` within snapshot root |

### `events/{run_id}.json`

Written once per run. Never overwritten.

```json
{
  "schema_version":    1,
  "repo_id":           "123456789",
  "repo_name":         "my-org/my-service",
  "repo_display_name": "my-service",
  "run_id":            "9876543210",
  "timestamp":         "2026-04-12T10:00:00.000Z",
  "verdict":           "BLOCKED",
  "FLAKY":             1,
  "REGRESSION":        2,
  "NEW_BUG":           0,
  "ENV_ISSUE":         0,
  "failures": [
    {
      "test_name":  "ProductSearchTest.searchProductWithWrongPriceAssertion",
      "error_hash": "d4e5f6",
      "category":   "REGRESSION",
      "confidence": 0.95
    }
  ]
}
```

Fields in `failures[]` contain **only** compact summary data — no raw error messages, no LLM reasoning, no suggested fix payloads. Full detail remains in the SQLite DB.

---

## Local mode vs hosted mode

### Local mode (default)

`ORACLE_SNAPSHOT_ROOT` is **not** set in the dashboard server environment. The server reads `ORACLE_STATE_DB_PATH` as before. All existing single-repo routes (`/api/v1/*`) work unchanged. No repo-scoped routes are registered.

### Hosted mode

`ORACLE_SNAPSHOT_ROOT` is set. The server additionally registers repo-scoped API routes that open `repos/{repoId}/latest.db` read-only on demand.

---

## Dashboard repo-scoped routes

These routes are only active when `ORACLE_SNAPSHOT_ROOT` is set.

| Method | Path                                    | Description                                      |
|--------|-----------------------------------------|--------------------------------------------------|
| GET    | `/api/repos`                            | List all repos (reads all `manifest.json` files) |
| GET    | `/api/repos/:repoId/manifest`           | Raw `manifest.json` for a repo                   |
| GET    | `/api/repos/:repoId/overview`           | Overview stats from the repo's `latest.db`       |
| GET    | `/api/repos/:repoId/failures`           | Top recurring failures from `latest.db`          |
| GET    | `/api/repos/:repoId/actions`            | Action verdict summary from `latest.db`          |
| GET    | `/repos/:repoId`                        | SPA entry point (serves `index.html`)            |
| GET    | `/repos/:repoId/embed`                  | SPA embed entry point (serves `index.html`)      |

---

## Display name behavior

The dashboard header shows `repoDisplayName` when in repo-scoped mode. Fallback chain:

1. `ORACLE_REPO_DISPLAY_NAME` env var (explicit)
2. Last segment after `/` in `repo_name` (e.g. `my-org/my-service` → `my-service`)
3. `repo_id` itself (when no `repo_name` is available)

The UI fetches `/api/repos/:repoId/manifest` on load and uses `repo_display_name` from the response.

---

## CI artifact upload

Snapshots in `oracle-snapshots/` are uploaded as a GitHub Actions artifact named `oracle-snapshots` with 30-day retention via the `Upload Stage 2 snapshot artifacts` step in `.github/workflows/oracle-triage.yml`.

For hosted deployment, these artifacts can be synced to S3 or GCS after the workflow completes:

```yaml
- name: Sync snapshots to S3 (example — not included in this PR)
  run: aws s3 sync oracle-snapshots/ s3://my-bucket/oracle-snapshots/
```

The hosted dashboard server then mounts the S3-synced directory as `ORACLE_SNAPSHOT_ROOT`. This pattern is intentionally out of scope for Stage 2 — the pipeline produces the artifacts; syncing is a deployment concern.

---

## Backward compatibility

All Stage 2 changes are **additive**:

- `saveRun()` accepts an optional `repoIdentity` parameter (5th arg, default `undefined`). Existing callers with 4 args continue to work.
- New `repo_id`, `repo_name`, `repo_display_name` columns are added to the `runs` table via additive `ALTER TABLE ... ADD COLUMN` migrations. Existing rows get `NULL` for these columns, which is correct and harmless.
- `dashboard-queries.ts` functions accept an optional `db` parameter. When omitted, they use `getDb()` as before.
- The hosted-mode routes are only registered when `ORACLE_SNAPSHOT_ROOT` is set. Without it, the server is identical to Stage 1.
- Snapshot export is wrapped in `try/catch` and is **non-fatal** — a failure to write snapshots does not fail the triage run.
