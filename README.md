# AI Oracle

AI-powered test failure triage for GitLab CI and GitHub Actions. Reads test
reports after a failed pipeline run, classifies each failure, opens Jira defects,
and posts a Slack summary — so your team knows exactly what broke and why before
anyone looks at the logs.

---

## How it works

1. Your E2E or API test job runs and fails
2. The Oracle job triggers automatically (`when: on_failure`)
3. Oracle reads the test report and classifies every failure into one of four categories using Claude
4. A policy engine decides which actions to take — Jira defects for regressions and new bugs (confidence > 0.7), Slack summary for every run
5. Actions are fingerprinted and deduplicated — re-running the same pipeline never creates duplicate Jira tickets or Slack posts
6. Historical pattern stats are logged per failure — showing how many times an action was taken, how many Jiras were duplicates, and whether retries have worked before
7. Results and action audit trail are persisted to SQLite so patterns are learned over successive runs

### Operating modes

Oracle has three distinct operating modes, evaluated in priority order:

| Mode | Trigger | Purpose |
|---|---|---|
| **Feedback ingestion** | `ORACLE_FEEDBACK_PATH` set | Ingest operator feedback (Jira outcomes, classification corrections) into SQLite. No API key required. |
| **Agent proposal** | `ORACLE_AGENT_PROPOSALS_PATH` set | Process action proposals from AI agents. Policy engine decides each proposal; approved actions are executed. No API key required. |
| **Normal CI triage** | Neither path set | Full triage: parse report → classify with Claude → propose and execute actions → post Slack + PR comment. |

### Separation of concerns

The LLM **only classifies** — it outputs a category, confidence score, reasoning, and suggested fix for each failure. It does not decide whether to open a Jira ticket. That decision belongs to the **policy engine** (`src/policy-engine.ts`), which applies deterministic rules and persists every decision with its full audit context to the `actions` table.

**Agents are never trusted executors.** Agent proposals flow through the same policy engine as policy-generated actions. Every proposal is recorded in `agent_proposals` and linked to the shared `actions` ledger regardless of its verdict (approved, held, or rejected).

### Failure categories

| Category | Meaning |
|---|---|
| `FLAKY` | Timing issue, race condition, or transient network error — retry-able |
| `REGRESSION` | Genuine change in app behaviour or API contract break |
| `ENV_ISSUE` | CI environment problem — certificate error, proxy, missing service |
| `NEW_BUG` | Previously unseen failure that doesn't fit the above |

---

## Supported report formats

Oracle auto-detects the format from the file extension and content:

| Format | Detection | Covers |
|---|---|---|
| Playwright JSON | `.json` with `suites` key | Playwright E2E and API tests |
| JUnit XML | `.xml` extension | Java/REST Assured, C#/NUnit, Python/pytest, any xUnit tool |
| pytest JSON | `.json` with `tests[].nodeid` | Python pytest with `--json-report` |

Override detection with the `REPORT_FORMAT` environment variable:
```
REPORT_FORMAT=JUNIT_XML
REPORT_FORMAT=PLAYWRIGHT_API
REPORT_FORMAT=PYTEST_JSON
REPORT_FORMAT=PLAYWRIGHT_JSON
```

---

## Quick start

### GitLab CI

In your consuming repo's `.gitlab-ci.yml`:

```yaml
stages:
  - test
  - e2e
  - oracle     # add after your test stage
  - deploy

include:
  - project: your-group/ai-oracle
    ref: main
    file: oracle-stage.yml

oracle-triage:
  extends: .oracle-triage
  needs:
    - job: your-e2e-job
      artifacts: true
  variables:
    PLAYWRIGHT_REPORT_PATH: test-results/
```

Add variables in **Settings → CI/CD → Variables**:

| Variable | Description | Protected | Masked |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | AI API key | yes | yes |
| `ATLASSIAN_TOKEN` | Jira API token | yes | yes |
| `ATLASSIAN_BASE_URL` | e.g. `https://your-org.atlassian.net` | no | no |
| `ATLASSIAN_PROJECT_KEY` | Jira project key e.g. `QA` | no | no |
| `SLACK_WEBHOOK_URL` | Incoming webhook URL | yes | yes |
| `ORACLE_FEEDBACK_PATH` | Path to feedback JSON file (enables feedback ingestion mode) | no | no |
| `ORACLE_AGENT_PROPOSALS_PATH` | Path to agent proposals JSON file (enables agent proposal mode) | no | no |
| `RETRY_COMMAND` | Shell command to execute when a `retry_test` proposal is approved | no | no |

---

### GitHub Actions

In your consuming repo's workflow file:

```yaml
jobs:
  your-test-job:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: npx playwright test
      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: test-results/

  oracle-triage:
    needs: [your-test-job]
    if: failure()
    uses: your-org/ai-oracle/.github/workflows/oracle-triage.yml@main
    with:
      report-path: test-results/results.json
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      atlassian-token: ${{ secrets.ATLASSIAN_TOKEN }}
      atlassian-base-url: ${{ secrets.ATLASSIAN_BASE_URL }}
      atlassian-project-key: ${{ secrets.ATLASSIAN_PROJECT_KEY }}
      slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

The `verdict` output (`CLEAR` or `BLOCKED`) can be used by downstream jobs. The full `oracle-verdict.json` structure is:

```json
{
  "verdict": "BLOCKED",
  "FLAKY": 1,
  "REGRESSION": 1,
  "NEW_BUG": 0,
  "ENV_ISSUE": 0,
  "failures": [
    {
      "testName": "checkout applies voucher",
      "errorHash": "a3f9c1d2",
      "category": "REGRESSION",
      "confidence": 0.92,
      "pattern_stats": {
        "actionCount": 5,
        "jiraCreatedCount": 3,
        "jiraDuplicateCount": 2,
        "retryPassedCount": 2,
        "retryFailedCount": 1
      }
    }
  ]
}
```

The top-level `verdict` and category counts are unchanged from previous versions. The `failures[]` array is additive.

The `verdict` output (`CLEAR` or `BLOCKED`) can be used by downstream jobs:

```yaml
  deploy:
    needs: [oracle-triage]
    if: needs.oracle-triage.outputs.verdict == 'CLEAR'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Deploy approved — no regressions found"
```

Add the same secrets in **Settings → Secrets and variables → Actions**.

Optional variables for feedback and agent proposal modes:

| Variable | Description |
|---|---|
| `ORACLE_FEEDBACK_PATH` | Path to a feedback JSON file — enables feedback ingestion mode |
| `ORACLE_AGENT_PROPOSALS_PATH` | Path to an agent proposals JSON file — enables agent proposal mode |
| `RETRY_COMMAND` | Shell command run when an approved `retry_test` proposal executes |

---

### 3. Enable the JSON reporter in Playwright

```ts
// playwright.config.ts
reporter: [
  ['html'],
  ['json', { outputFile: 'playwright-report/results.json' }]
]
```

For pytest, run with:
```bash
pytest --json-report --json-report-file=report.json
```

For JUnit (Maven/Gradle/NUnit/etc.), point `PLAYWRIGHT_REPORT_PATH` at the
XML output your tool already produces — no extra configuration needed.

---

## Local development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run unit tests
npm test

# Dry-run triage against a local report (prints JSON, skips Jira + Slack)
ANTHROPIC_API_KEY=sk-ant-... \
PLAYWRIGHT_REPORT_PATH=./my-report.json \
npm run triage:dry

# Full triage run (requires all env vars)
npm run triage

# Generate instinct files from SQLite history (run after every 5–10 CI runs)
npm run learn

# Ingest operator feedback from a JSON file
ORACLE_FEEDBACK_PATH=./feedback.json npm run triage

# Process agent proposals from a JSON file
ORACLE_AGENT_PROPOSALS_PATH=./proposals.json npm run triage
```

### Feedback ingestion

Feedback is a JSON file (single object or array) with these fields:

```json
[
  {
    "feedback_type": "jira_closed_duplicate",
    "pipeline_id": "12345",
    "test_name": "Login > should redirect after auth",
    "error_hash": "a3f9c1d2",
    "notes": "Duplicate of PROJ-42"
  }
]
```

Valid `feedback_type` values: `jira_closed_duplicate`, `jira_closed_confirmed`, `classification_corrected`, `action_overridden`, `retry_passed`, `retry_failed`.

### Agent proposal intake

Agent proposals are a JSON file (single object or array) using snake_case keys:

```json
[
  {
    "source_agent": "flaky-detector-v1",
    "proposal_type": "retry_test",
    "pipeline_id": "12345",
    "test_name": "Login > should redirect after auth",
    "error_hash": "a3f9c1d2",
    "confidence": 0.85,
    "reasoning": "This error pattern matches known flaky selector timing",
    "payload": {}
  }
]
```

Supported `proposal_type` values: `retry_test`, `request_human_review`.

The policy engine applies confidence thresholds to `retry_test` proposals:
- **≥ 0.8** → approved and executed (requires `RETRY_COMMAND` to be set)
- **0.5–0.79** → held, written to `oracle-held-actions.json` for operator review
- **< 0.5** → rejected

All proposals are recorded in `agent_proposals` and linked to the `actions` ledger regardless of verdict.

---

## Historical pattern stats (explainability)

On every normal CI triage run, Oracle looks up the history for each failure pattern (`testName + errorHash`) and logs it before any decisions are made. This gives operators full context — no ML, no scoring, just counts from existing data.

```
[history] checkout applies voucher (a3f9c1d2)
  actions=5  jira_created=3  jira_duplicates=2  retry_passed=2  retry_failed=1
```

| Field | What it answers |
|---|---|
| `actions` | Have we seen this failure pattern before? |
| `jira_created` | Did we already raise a Jira for it? |
| `jira_duplicates` | Were those Jiras useful, or were they closed as duplicates? |
| `retry_passed` | Does retrying this test usually work? |
| `retry_failed` | Or does it stay broken after a retry? |

These stats are **read-only** — they are surfaced for explainability and never influence decisions. They are also written per failure into `oracle-verdict.json` under a `failures[]` array alongside the existing top-level verdict and category counts.

---

## Learning over time

Oracle gets smarter with each run. After a failure appears 3+ times with the
same error signature and consistent classification (confidence > 0.7), `npm run learn`
writes a pattern file to `.instincts/`. These files are committed to the repo and
injected into the prompt on future runs, improving accuracy for known patterns.

```
.instincts/
  a3f9c1d2b4e5.md   # "canvas selector timeout → FLAKY, add waitForSelector"
  7b2e4f8a1c3d.md   # "401 on /api/v2/auth → REGRESSION, API contract changed"
```

---

## Project structure

```
src/
  types.ts                  — shared interfaces, enums, and action types
  index.ts                  — entry point and orchestration flow (3 modes)
  report-parser.ts          — multi-format parser (Playwright, JUnit, pytest)
  triage.ts                 — AI classification via Claude API
  prompt-builder.ts         — prompt assembly
  policy-engine.ts          — action proposal, fingerprinting, and decision logic
  state-store.ts            — SQLite persistence (runs, failures, actions audit trail)
  feedback-processor.ts     — feedback ingestion from JSON files
  agent-proposal-loader.ts  — agent proposal validation and loading
  held-actions-writer.ts    — writes oracle-held-actions.json for operator review
  instinct-loader.ts        — loads .instincts/ into prompt context
  jira-writer.ts            — Jira REST API integration (single-defect interface)
  slack-notifier.ts         — Slack webhook integration
  learn.ts                  — instinct generation script
oracle-stage.yml            — GitLab CI stage (include this in consuming repos)
.github/workflows/
  oracle-triage.yml         — reusable GitHub Actions workflow
tests/
  fixtures/                 — synthetic test reports for all supported formats
```

### SQLite schema

| Table | Purpose |
|---|---|
| `runs` | One row per pipeline run — timestamp, pipeline ID, failure counts |
| `failures` | One row per triaged failure — category, confidence, error hash |
| `actions` | Unified audit ledger for every proposed and executed action — fingerprint, verdict, source (`policy`/`agent`), payload, confidence, decision reason, execution result |
| `feedback` | Operator feedback entries — Jira outcomes, classification corrections, retry results |
| `agent_proposals` | Intake record for every agent proposal — status lifecycle (`received` → `approved`/`held`/`rejected` → `executed`), linked to `actions` via fingerprint |
| `instinct_feedback` | Correctness feedback for learned instinct patterns |

---

## npm scripts

| Script | Description |
|---|---|
| `npm test` | Run all unit tests |
| `npm run test:live` | Run live triage test against a real report |
| `npm run typecheck` | TypeScript type check, no output |
| `npm run triage` | Full triage run |
| `npm run triage:dry` | Triage with JSON output only — skips Jira and Slack |
| `npm run learn` | Generate instinct files from SQLite history |
| `npm run build` | Compile TypeScript to `dist/` |
