# Oracle Experiment Fixtures

Playwright JSON report fixtures used by `scripts/run-local-experiment.sh` to
validate oracle classification **without a real browser or CI pipeline**.

Each fixture is a minimal, self-contained Playwright JSON report whose error
content unambiguously (or deliberately ambiguously) encodes the intended oracle
category. Test and spec names are intentionally neutral — the oracle must
classify purely from the error message content.

---

## Fixture catalogue

### `pw-flaky.json`
| Field            | Value |
|------------------|-------|
| **Oracle label** | `FLAKY` |
| **Type**         | Clear classification |
| **Signal**       | `Timeout 30000ms exceeded`, element found but not stable, 2 retries — classic race/animation flake |
| **Confidence**   | Expected ≥ 80% |

---

### `pw-regression.json`
| Field            | Value |
|------------------|-------|
| **Oracle label** | `REGRESSION` |
| **Type**         | Clear classification |
| **Signal**       | Two `toHaveText` mismatches on concrete values (`$4.99` → `$5.99`, `In Stock` → `Out of Stock`) — wrong data returned, not a missing feature |
| **Confidence**   | Expected ≥ 90% |

---

### `pw-new-bug.json`
| Field            | Value |
|------------------|-------|
| **Oracle label** | `NEW_BUG` |
| **Type**         | Clear classification |
| **Signal**       | Element not found after 5 s, page title `"Reports — Coming Soon"`, URL contains `?feature=disabled` — feature deliberately disabled, never worked |
| **Confidence**   | Expected ≥ 90% |

---

### `pw-env-issue.json`
| Field            | Value |
|------------------|-------|
| **Oracle label** | `ENV_ISSUE` |
| **Type**         | Clear classification |
| **Signal**       | `ERR_CONNECTION_REFUSED` on one test + expired SSL cert (`CERT_HAS_EXPIRED`) on another — infrastructure-level failures, no app code involved |
| **Confidence**   | Expected ≥ 95% |

---

### `pw-ambiguous.json`
| Field            | Value |
|------------------|-------|
| **Oracle label** | `REGRESSION_or_NEW_BUG` (ambiguous — no gold-standard truth) |
| **Type**         | Edge-case / ambiguous reasoning |
| **Signal**       | `toHaveCount(5)` received 0 elements — could mean the feature was removed (REGRESSION) or never shipped to this env (NEW_BUG) |
| **Expected behaviour** | Oracle should pick one category at reasonable confidence; the runner marks this row ⚠️ and does **not** count it as a pass/fail |

---

## Running locally

```bash
ANTHROPIC_API_KEY=sk-... ./scripts/run-local-experiment.sh
```

## Stability contract

- Fixture filenames are **stable** — experiment scripts reference them by name.
  Do not rename without updating `scripts/run-local-experiment.sh`.
- Fixtures must remain **deterministic** — no timestamps, random paths, or
  environment-specific URLs that would change oracle output between runs.
- The `pw-ambiguous.json` fixture is **explicitly excluded from accuracy scoring**
  and must never be promoted to a gold-standard truth label.
