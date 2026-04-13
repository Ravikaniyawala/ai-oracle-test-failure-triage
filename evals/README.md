# Oracle Evals — v1

This directory contains the evaluation foundation for AI Oracle.

**Current status:** v1 — real labeled dataset from SQLite history and operator feedback, practical metrics, no fake benchmark claims.

---

## What this measures

Oracle's job is to classify CI test failures into categories
(`FLAKY`, `REGRESSION`, `ENV_ISSUE`, `NEW_BUG`) and decide whether to block a
deploy. The eval system measures two things:

1. **Block decision accuracy** — did Oracle block (BLOCKED) or clear (CLEAR) the right runs?
2. **Category accuracy** — when a human corrected Oracle's classification, how often was Oracle already correct?

---

## Dataset format

Each exported case is a JSONL line (`schema_version = 1`):

```jsonc
{
  "schema_version": 1,           // always 1 in this version
  "case_id": "fp:abc123ef:retry_passed",
                                 // "<evidence>:<fingerprint_prefix>:<feedback_type>"
  "repo_id":   "123456789",      // GitHub repository_id, nullable
  "repo_name": "org/repo",       // GitHub repository name, nullable
  "pipeline_id": "12345",        // CI run that produced the prediction
  "test_name":   "Suite > test", // test identifier
  "error_hash":  "abc123ef0012", // SHA-256 prefix of error message
  "predicted_category":    "FLAKY",   // Oracle's classification
  "predicted_confidence":  0.82,      // Oracle's confidence score
  "predicted_should_block": false,    // derived from category (REGRESSION/NEW_BUG = true)
  "gold_category":    "FLAKY",        // nullable — human-confirmed category
  "gold_should_block": false,         // derived from evidence
  "evidence_source":  "retry_passed", // feedback type that produced the label
  "label_quality":    "high",         // "high" or "medium"
  "created_at": "2026-04-01T10:00:00.000Z"
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | int | Always 1 in this version |
| `case_id` | string | Stable identifier for this labeled case |
| `repo_id` | string\|null | GitHub repository_id if available |
| `repo_name` | string\|null | GitHub repository name if available |
| `pipeline_id` | string | CI pipeline that generated the prediction |
| `test_name` | string | Full test name |
| `error_hash` | string | 12-char SHA-256 prefix of the error message |
| `predicted_category` | string | Oracle's triage category |
| `predicted_confidence` | number | Oracle's confidence 0–1 |
| `predicted_should_block` | bool | True if category is REGRESSION or NEW_BUG |
| `gold_category` | string\|null | Human-confirmed category (null if unknown) |
| `gold_should_block` | bool | Ground-truth block decision |
| `evidence_source` | string | Feedback type that produced the label |
| `label_quality` | string | `high` or `medium` |
| `created_at` | string | ISO timestamp of the feedback row |

---

## What counts as a gold label

v1 uses three feedback types as evidence:

| Feedback type | Gold label assigned | Quality | Notes |
|---|---|---|---|
| `classification_corrected` | `gold_category = new_value`, `gold_should_block` derived | `high` | Only if `new_value` is a valid Oracle category AND the row links to exactly one failure |
| `retry_passed` | `gold_category = FLAKY`, `gold_should_block = false` | `high` | A test that passed on retry is flaky by definition |
| `jira_closed_confirmed` | `gold_should_block = true`, `gold_category = null` | `medium` | Confirms the block decision was correct, but does not confirm the specific category |

### Failure linkage rules

Each exported case must link to a single, unambiguous failure row:

- **With `feedback.pipeline_id`** (preferred): the exporter queries only the run for that pipeline. If no matching failure exists in that run, the row is skipped.
- **Without `feedback.pipeline_id`** (legacy rows): the pattern must appear in exactly one run — any multi-run match is skipped, even when all runs produced the same category. This avoids silently exporting the wrong `pipeline_id` or `predicted_confidence`.

The `case_id` field (`fb<feedback_row_id>:<hash_prefix>:<feedback_type>`) is unique per exported row and stable across re-exports.

### What is excluded in v1

| Feedback type | Reason excluded |
|---|---|
| `retry_failed` | Failure after retry may be REGRESSION, NEW_BUG, or ENV_ISSUE — cannot assign category safely |
| `jira_closed_duplicate` | Confirms a Jira was filed, not that the classification or block was correct |
| `action_overridden` | Too ambiguous — override may correct a bad action without correcting the classification |
| Feedback rows not linkable to a single failure | See linkage rules above |

---

## Metrics

| Metric | Formula | Interpretation |
|---|---|---|
| `block_precision` | TP_block / (TP_block + FP_block) | Of runs Oracle blocked, what fraction should have been blocked |
| `false_block_rate` | FP_block / (FP_block + TN_block) | Of runs that should have cleared, what fraction did Oracle block |
| `false_clear_rate` | FN_block / (FN_block + TP_block) | Of runs that should have blocked, what fraction did Oracle clear |
| `category_accuracy` | correct_category / cases_with_gold_category | On labeled cases with a gold category, how often did Oracle predict it |

TP/FP/FN/TN are computed at the **failure level** using `gold_should_block` vs
`predicted_should_block`, because Oracle's verdict is derived from individual
failure classifications.

---

## Running evals locally

**Step 1: Export a dataset from your Oracle state DB**

```bash
ORACLE_STATE_DB_PATH=/path/to/oracle-state.db \
  npm run eval:export -- --output evals/dataset.jsonl
```

Optional flags:
- `--output <path>` — write to file instead of stdout
- `--min-quality medium` — include `medium` quality labels (default: `high` only)

**Step 2: Score the dataset**

```bash
npm run eval:score -- --input evals/dataset.jsonl
```

Optional flags:
- `--input <path>` — default: stdin
- `--output <path>` — write JSON metrics to file
- `--min-quality medium` — include medium-quality labels in scoring

**Example end-to-end**

```bash
ORACLE_STATE_DB_PATH=~/.oracle/my-repo/oracle-state.db \
  npm run eval:export -- --output /tmp/oracle-eval.jsonl && \
  npm run eval:score -- --input /tmp/oracle-eval.jsonl
```

---

## Current limitations

1. **Block decisions are at the failure level, not run level.** Oracle's `verdict`
   is derived from individual failure categories. The eval dataset labels individual
   failures, so `block_precision` / `false_block_rate` are failure-level metrics,
   not run-level.

2. **No LLM replay.** This eval system measures Oracle's persisted predictions against
   human feedback. It does not re-run the LLM against historical inputs. That is
   intentional — replaying the LLM would require storing raw error payloads (which
   may be sensitive) and would not reflect the exact prompt state at the time of
   prediction.

3. **Dataset size depends on feedback volume.** A fresh Oracle installation has zero
   feedback rows and an empty eval dataset. The dataset grows as operators submit
   feedback via the feedback ingestion endpoint.

4. **The state DB is per consuming-repo.** There is no central DB. Each team runs
   eval exports against their own `oracle-state.db`, which is typically stored in
   the GitHub Actions cache. To run evals, you must first download the DB artifact
   from a recent pipeline run.

5. **`jira_closed_confirmed` does not confirm the category.** It only confirms that
   the block decision was correct. `gold_category` is null for these cases.

---

## Next steps

Once the dataset has stabilised (≥50 high-quality cases), consider:

- Adding a scheduled / manual GitHub Actions workflow in consuming repos to
  export the dataset, score it, and post results as a PR comment or artifact.
  The workflow should live in the consuming repo because that is where the
  production DB is.

- Upgrading `classification_corrected` to `label_quality = high` for all valid
  corrections (it already is), and expanding the `jira_closed_confirmed` signal
  to use category information when available in the notes field.

- Tracking metric trends across DB snapshots to detect model regressions.
