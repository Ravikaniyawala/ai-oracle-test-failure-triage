# AI Oracle

Agent harness context for Claude Code working on this repo.

## What this repo does
Reads Playwright JSON test reports, classifies failures using the Anthropic API,
writes Jira defects, posts Slack alerts, and persists learnings to SQLite.

## Key files
- src/types.ts — all shared interfaces, TriageCategory enum, ReportFormat enum, ParseResult
- src/index.ts — entry point, reads PLAYWRIGHT_REPORT_PATH env var
- src/report-parser.ts — multi-format parser, supports Playwright JSON, JUnit XML, pytest JSON
- src/triage.ts — calls Anthropic API with failure data + instinct context
- src/state-store.ts — SQLite wrapper at ORACLE_STATE_DB_PATH
- oracle-stage.yml — the GitLab CI stage definition consumed by other repos
- .github/workflows/oracle-triage.yml — reusable GitHub Actions workflow, equivalent of oracle-stage.yml for GitHub CI
- .instincts/ — learned pattern files, populated by npm run learn

## Environment variables (all required in CI)
- ANTHROPIC_API_KEY
- ATLASSIAN_TOKEN — Jira API token
- ATLASSIAN_BASE_URL — e.g. https://your-org.atlassian.net
- ATLASSIAN_PROJECT_KEY — Jira project key for defects e.g. QA
- SLACK_WEBHOOK_URL
- PLAYWRIGHT_REPORT_PATH — path to the test report in consuming repo (any supported format)
- ORACLE_STATE_DB_PATH — defaults to ./oracle-state.db
- REPORT_FORMAT — optional override to force format detection, accepts:
  PLAYWRIGHT_JSON | PLAYWRIGHT_API | JUNIT_XML | PYTEST_JSON

## Coding standards
- Node.js 20, TypeScript 5, strict mode enabled
- ESM modules (module: NodeNext in tsconfig)
- Async/await throughout, no callbacks
- All interfaces and enums live in src/types.ts — never define types inline
- Each src/ file exports one primary function
- Errors are caught and logged; Oracle never fails the pipeline (exit 0 always)
- Tests use Node built-in test runner (node:test) with tsx for execution
- No any types — use unknown and narrow explicitly

## Triage classification
Four categories only: FLAKY | REGRESSION | ENV_ISSUE | NEW_BUG
Defined as a TypeScript enum in src/types.ts.
Each failure gets one category, a confidence score 0-1, and a suggested fix.

## SQLite schema
Table: runs (id, timestamp, pipeline_id, total_failures, categories_json)
Table: failures (id, run_id, test_name, error_hash, category, confidence, fix_applied)
Table: instinct_feedback (id, instinct_id, was_correct, timestamp)

## npm scripts
- npm test              — run all tests via tsx test runner
- npm run triage        — run a triage against PLAYWRIGHT_REPORT_PATH
- npm run learn         — scan SQLite runs and write new .instincts/ files
- npm run triage:dry    — run triage, print JSON to stdout, skip Jira + Slack
- npm run build         — compile TypeScript to dist/ for production
- npm run typecheck     — tsc --noEmit, no output, types only

## CI environment notes
- CI_PIPELINE_ID is read from CI_PIPELINE_ID (GitLab) or GITHUB_RUN_ID (GitHub Actions)
- index.ts resolves both automatically — no change needed in consuming repo config
