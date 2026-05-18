# Autofix Gating Design

**Status:** Phase 0 PASSED — Phase 1 ready to start
**Last revised:** 2026-05-18
**Review history:** four Codex review rounds; final verdict `GO WITH CONDITIONS`, conditions addressed in this doc. Phase 0 validation completed in aisle-checker (commit `fb3db78` on branch `phase0/autofix-detector-validation`).

---

## Executive summary

Extend ai-oracle-triage with a structural gating layer that decides when a
test-healing agent (TestHealer or similar) may safely auto-repair a failing
Playwright test. The detector emits `failureSource` and `repairabilityKind`
from non-LLM signals (stack frames, error regexes, PR overlap, ARIA-vs-locator
comparison, cross-test correlation, history counters) and combines them with
Oracle's existing LLM category classification to gate `fix_test_with_agent`
actions.

Safety property: **no false approvals**. The system fails closed for any
ambiguity. REGRESSION, NEW_BUG, and ENV_ISSUE failures can never enter the
autofix queue regardless of any other signal.

Oracle's role: decide what is safe to autofix.
Healer's role (out of scope for this design): apply the fix, re-run the test,
open a draft PR.

aisle-checker is the first consumer. Cross-repo rollout follows.

---

## Phase 0 results (2026-05-18)

Phase 0 ran end-to-end against `aisle-checker-api-tests-ai-triage` at
commit `fb3db78` on branch `phase0/autofix-detector-validation`. All four
exit criteria passed.

| Criterion | Threshold | Observed | Verdict |
|---|---|---|---|
| EC1 — Topology validation passes | state ≠ failed | `partial` (correct first-time outcome) | ✅ PASS |
| EC2 — Artifact supply chain ≥95% on 50-failure sample | parser + end-to-end ≥95% | 100% / 100% | ✅ PASS |
| EC3 — Locator-drift classifier ≥85% per sub-kind | every sub-kind ≥85% | 100% min (worst-case) on 80 hand-crafted + 200 synthetic cases | ✅ PASS |
| EC4 — Defaults reconcile against repo layout | both globs match ≥1 file | product=18, allowed=54 | ✅ PASS |

Evidence lives in `aisle-checker-api-tests-ai-triage/tests/e2e/oracle-phase0/`:
- `reports/PHASE0_FINDINGS.md` — human-readable verdict
- `reports/{topology-validation,classifier-eval,reporter-coverage,defaults-reconciliation}.json` — machine-readable per-check artifacts
- `tests/` — 62 unit tests, all pass

### Reconciliation findings to land in Phase 1

Two repo-specific findings surfaced during P0.4 that Phase 1 implementation
must accommodate. Neither blocks Phase 0; both inform how Phase 1's
per-repo configuration should behave.

1. **Test attribute name override.** aisle-checker uses
   `testIdAttribute: 'data-test'` (not `data-testid`) in
   `playwright.config.ts`. The Phase 1 detector must read the consumer's
   Playwright config (or accept a per-repo override env var) and include
   that attribute name in the test-attribute list for the locator-drift
   classifier. The Phase 0 spike already supports a configurable
   `testAttributeNames` parameter — keep that affordance.

2. **Page-objects / fixtures path scoping.** aisle-checker's page objects
   live at `tests/e2e/src/pages/` and fixtures at `tests/e2e/src/fixtures/`.
   These are covered by the `tests/**` allowed-edit pattern but NOT by the
   more specific `page-objects/**` and `fixtures/**` patterns in the
   default `allowedEditPaths`. Two acceptable options:
   - Keep both pattern sets (defensive; harmless for repos using either
     convention).
   - Replace `page-objects/**` and `fixtures/**` with `tests/**/pages/**`
     and `tests/**/fixtures/**` (more flexible for monorepo layouts).
   Recommendation: keep both. The cost is one extra glob check per file
   at scan time; the benefit is correct coverage across repo conventions.

### Phase 0 deliverables NOT in Oracle

The Phase 0 spike modules in aisle-checker (topology validator, locator
parser, path normalizer, provenance checker, ARIA classifier, prompt
reporter) are **reference implementations**, not source-of-truth code.
Phase 1 must re-implement them in `src/autofix-detector/` upstream rather
than import them — this was the deliberate decoupling decision called out
in the design.

The aisle-checker fixture corpus (50 Playwright error fixtures + 280
locator-drift cases) is reusable. Phase 1 can copy it into Oracle's test
suite as the starting baseline; the hand-crafted set should expand as
real-world failure shapes accumulate from propose-mode runs.

---

## Why this design

Test-healing agents can fix locator drift, timing flakes, and simple Playwright
API misuse — but they can also "fix" tests that are correctly catching real
product regressions, which masks bugs. The naive approach ("auto-heal anything
classified FLAKY") trusts a single LLM classifier as the safety boundary;
misclassifications then ship as silent regressions.

This design treats Oracle's LLM category as one of multiple required signals,
not the sole gate. A structural detector — computed from independent
non-LLM signals — must independently agree that the failure is test-code in
origin AND positively repairable in shape AND that no hard negative guards
fired. Approval requires every layer to agree.

The defense-in-depth claim holds only because the structural detector and the
LLM classifier are computed from genuinely independent signals. Preserving
that independence is the load-bearing engineering invariant of the whole
design.

---

## Gating contract

`fix_test_with_agent` is approved if and only if ALL of the following hold:

```
Gate 1: LLM category = FLAKY
Gate 2: failureSource = test_code
        AND sourceConfidence >= topology-specific threshold
Gate 3: totalSourceEvidenceWeight >= topology-specific floor
Gate 4: repairabilityKind in AUTO_ELIGIBLE_KINDS
Gate 5: repairabilityConfidence >= 0.70
Gate 6: zero hard negative guards fired
        AND selfModificationGuard = false
        AND productModificationGuard = false
Gate 7: topology permits auto mode for this repo
Gate 8: artifactTrustLevel = 'trusted'
```

Any failure of any gate routes the candidate to "held" (propose mode) or
"rejected" (auto mode), per the routing matrix. Approval only happens in auto
mode by construction.

REGRESSION, NEW_BUG, and ENV_ISSUE categories are rejected at Gate 1
unconditionally. No structural signal, mode, override, or topology can promote
them into the autofix queue. This invariant must be pinned by a test
explicitly in Phase 1.

### Confidence vs evidence weight

`sourceConfidence` is RELATIVE confidence among fired signals — how much the
winning attribution dominates. `totalSourceEvidenceWeight` is ABSOLUTE
evidence strength — the sum of weights regardless of relative dominance.

A single weak signal can produce high relative confidence but still fail the
absolute floor. Both gates must pass independently. In walkthroughs, audit
output, and dashboards, both values must appear separately.

---

## Detector output schema

```ts
interface DetectionResult {
  // Source attribution
  failureSource:                'test_code' | 'app_code' | 'environment' | 'unknown';
  sourceConfidence:             number;        // 0-1, RELATIVE dominance
  totalSourceEvidenceWeight:    number;        // 0-∞, ABSOLUTE evidence strength
  sourceEvidence:               SourceSignal[];
  sourceEvidenceWeightBySource: {              // per-source breakdown for audit
    test_code:                  number;
    app_code:                   number;
    environment:                number;
  };

  // Repairability
  repairabilityKind:            RepairabilityKind | null;
  repairabilityConfidence:      number;        // 0-1
  repairabilityEvidence:        RepairabilitySignal[];
  repairabilityTarget?: {                      // what the healer would touch
    file:                       string;
    locator?:                   string;
    elementRoleAndName?:        string;
  };

  // Guards
  hardNegativeGuards:           HardGuard[];   // any fired → reject autofix
  selfModificationGuard:        boolean;       // PR.filesChanged ∩ allowedEditPaths
  productModificationGuard:     boolean;       // PR.filesChanged ∩ product paths

  // Topology
  repoTopology:                 'monorepo_unit' | 'monorepo_e2e' | 'split_e2e';
  topologyValidation: {
    declared:                   'monorepo_unit' | 'monorepo_e2e' | 'split_e2e';
    state:                      'full' | 'partial' | 'failed';
    validationFailures:         string[];
  };
  topologyAllowsAuto:           boolean;       // false for split_e2e + partial in Phase 1
  topologyThresholds: {                        // what was actually applied
    sourceConfidenceFloor:      number;
    totalEvidenceFloor:         number;
  };

  // Mode + decision
  effectiveMode:                'off' | 'propose' | 'auto';   // post-topology-override
  routingDecision:              'approve' | 'hold' | 'reject';
  routingReason:                string;                       // matrix row reason

  // Audit / debug
  detectorVersion:              string;        // semver; bumps invalidate prior labels
  configVersion:                string;        // hash of thresholds/globs/regexes in effect
  normalizedTestFile:           string;        // repo-relative, source-map-resolved
  artifactTrustLevel:           'trusted' | 'partial' | 'untrusted';
  decisionTraceId:              string;        // unique per detector invocation
  evidenceArtifactPaths: {                     // exact file pointers for audit
    promptMd?:                  string;
    ariaSnapshot?:              string;
    trace?:                     string;
    screenshot?:                string;
  };
}

type RepairabilityKind =
  // Auto-eligible kinds
  | 'locator_drift_data_testid_only'
  | 'strict_mode_selector_ambiguity'
  | 'page_object_selector_drift_isolated'
  | 'known_playwright_api_misuse'
  // Hold/reject kinds
  | 'locator_drift_css_class_only'
  | 'locator_drift_user_visible_text'
  | 'locator_drift_dom_structure'
  | 'syntax_or_import_error'
  | 'fixture_data_drift'
  | 'snapshot_mismatch';
```

---

## Source-attribution signals

All structural, no LLM. Each signal carries `weight`, `pinning`, `provenance`
(trusted | untrusted), and human-readable `detail`.

### Signal 1 — Role-based stack-frame classification

NOT all-frames weighted summing. Frames are classified by role and only one
frame per role contributes:

- **Topmost non-framework user frame:**
  - if path matches `allowedEditPaths` → `test_code` 0.30
  - if matches `PRODUCT_SOURCE_PATTERNS` (post-exclusion) → `app_code` 0.60 HARD PIN
- **Deepest product source frame with trusted provenance** → `app_code` 0.60 HARD PIN
- **Browser pageerror / console exception frame in product source (trusted
  provenance only)** → `app_code` 0.70 HARD PIN
- **Playwright internal frames** → ignored for source attribution; never count
  as test_code
- **Untrusted-provenance frames** → weight halved, never trigger hard pins

For Playwright browser-driven E2E tests, the deepest-product-frame hard pin
rarely fires because the test runs in Node and the product code runs in a
separate browser process. The browser-pageerror signal is the primary way
product-code attribution reaches the detector in E2E scenarios, and only if
frontend JS throws AND source-map provenance is trusted.

### Signal 2 — Error pattern regexes

Surface-level pattern matching on errorMessage. Source-attribution
contributions:

```
/locator.*Timeout|waiting for locator|resolved to hidden/
  → test_code 0.35

/expect\(received\).*Received:.*Expected:/m
  → app_code 0.65 (NOT hard pin; see hard guards — value mismatch is a hard
    negative regardless of source attribution)

/strict mode violation|resolved to \d+ elements/
  → test_code 0.40

/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/
  → environment 0.70 HARD PIN

/HTTP (4|5)\d\d|Received:\s*(4|5)\d\d|toHaveURL|toHaveTitle/ mismatch
  → app_code 0.55 (NOT hard pin; HTTP mismatch is also a hard guard)

/Cannot find module|is not a function|SyntaxError|ReferenceError/
  in test-owned path → test_code 0.40

/browser(?:Type)? (closed|crashed)|Executable doesn't exist|browserType\.launch/
  → environment 0.70 HARD PIN

/toBeVisible|toHaveText|toContainText.*Timeout/
  → test_code 0.35 (Playwright assertion timeouts — usually waiting issue,
    not behavioral)

/beforeEach|beforeAll|globalSetup|fixture.*timeout|fixture.*error/i
  → test_code 0.40 (lifecycle/fixture hook failures; usually setup bugs)

/toBeOK|response\.json|body.*Expected/
  → app_code 0.55 (API response body assertions; usually genuine backend
    divergence)
```

### Signal 3 — Cross-test correlation (paired requirement)

Environment attribution requires BOTH:

- shared error signature count >= 5 AND >= 50% of total failures
- AND at least one infra-shaped error signal fired (network, browser
  lifecycle, DNS/cert)

Without infra-error pairing, emit `shared_failure_event` evidence and route to
held. Correlation alone never attributes environment (it could equally well
be an app-wide regression, auth outage, or shared fixture break).

### Signals explicitly NOT used for source attribution

- **PR diff overlap** — repurposed as safety guards (below). Disabled
  entirely in `split_e2e` topology since the PR cannot see app changes.
- **History counters** — feed suppression rules only; never source-positive.
  History is downstream of prior Oracle/healer decisions, so source-positive
  use would create a feedback loop where bad prior heals amplify future heals.

---

## Repairability signals

Computed by comparing the failing locator (parsed from errorMessage) against
the ARIA snapshot from Playwright `prompt.md`. All structural. Independent of
repo topology.

### Auto-eligible kinds

- **`locator_drift_data_testid_only`** (confidence 0.85+): failing selector
  references `data-testid`; ARIA snapshot has element with same role+name;
  only the testid attribute differs. Safe to auto-heal because the change is
  test-infrastructure, not product behavior.
- **`strict_mode_selector_ambiguity`** (0.80+): error message says "resolved
  to N elements"; fix is selector refinement.
- **`page_object_selector_drift_isolated`** (0.75+): failing frame in
  page-object file (per allowedEditPaths); single locator constant change.
- **`known_playwright_api_misuse`** (0.70+): missing `await`, wrong locator
  chaining, brittle `.nth()`, matched against curated pattern list.

### Hold/reject kinds

- **`locator_drift_css_class_only`** — CSS class names changed, no DOM or
  text change. Hold (could be styling refactor or behavioral selector change).
- **`locator_drift_user_visible_text`** — button label, link text, or ARIA
  name changed. **Always hold in propose, reject in auto.** This is the most
  likely failure mode for the whole system — user-visible changes could be
  intentional rebranding OR product regression; must be human-reviewed.
- **`locator_drift_dom_structure`** — element moved in DOM, parent/child
  changed, wrapper added. Structural product changes usually mean behavior
  changed. Hold.
- **`syntax_or_import_error`** — test file has compile error. Could be merge
  artifact or intentional refactor in progress. Hold.
- **`fixture_data_drift`** — test data doesn't match production
  schema/values. Business truth may have changed. Hold.
- **`snapshot_mismatch`** — visual or text snapshot diverged. Update policy
  must be explicit per-team. Hold by default.

If no repairability signal fires, `repairabilityKind = null`, gate 4 fails.
A generic Playwright timeout without specific repair evidence routes to held,
never approved.

---

## Hard negative guards

Independent of source attribution. Any guard firing → reject at gate 6.

- `value_mismatch` — concrete assertion value mismatch (matched by error
  regex). Even if structurally test_code, value mismatches usually indicate
  real behavioral change.
- `http_status_mismatch` — assertion on HTTP status returning 4xx/5xx that
  the test expected to be 2xx.
- `product_source_frame_with_trusted_provenance` — any trusted-provenance
  frame in product source (overlaps with source attribution but kept as
  independent guard for defense-in-depth).
- `environment_hard_pin` — any environment-pinning signal fired.
- `changed_test_owned_dependency_in_pr` — PR modified a page object, fixture,
  or shared test utility that the failing test imports.
- `missing_or_unsafe_artifact_path` — required Playwright artifacts
  (prompt.md, ARIA snapshot) are missing or paths are suspicious.
- `hard_pin_conflict` — multiple source-attribution hard pins disagree.
- **`artifact_trust_insufficient_for_auto`** — fires only when
  `effectiveMode == auto AND artifactTrustLevel != 'trusted'`. Cannot audit
  at trust level required for auto.
- **`ambiguous_repair_target`** — ARIA snapshot contains multiple candidate
  elements that match the failing locator's role but differ in user-visible
  name; healer cannot deterministically pick one.

### Notes on guards that explicitly do NOT belong here

- **`changed_product_source_in_pr`** — handled by `productModificationGuard`
  instead, so behavior can be mode-specific (hold in propose, reject in
  auto). Removing it here avoids triple-defining the same signal.
- **`assertion_removed_or_weakened`** — belongs DOWNSTREAM in the healer's
  patch-verification stage, not detector-time. The detector cannot check this
  without seeing a patch. The healer's CI step must parse the test file AST
  pre/post and reject patches that weaken assertions (no `toBe → toContain`,
  no removed assertions).

### Soft-rejection guard (not pure hard negative)

- **`missing_or_incomplete_aria_for_locator_repairability`** — fires when
  ARIA snapshot is missing/incomplete AND a locator-drift repairability kind
  would otherwise apply.
  - Default: route to hold (operator should fix artifact capture rather than
    silently drop the candidate).
  - Exception: reject ONLY when `effectiveMode == auto` AND locator-drift
    repairability would be the only approval path (no other AUTO_ELIGIBLE
    kind fires).

---

## PR-context safety guards

Computed once per failure from `prContext.filesChanged`.

- **`selfModificationGuard`**: `PR.filesChanged ∩ allowedEditPaths ≠ ∅` →
  never auto-heal (mode-independent reject). Works in all topologies.
- **`productModificationGuard`**: `PR.filesChanged ∩ PRODUCT_SOURCE_PATTERNS
  ≠ ∅` → mode-specific. Hold in propose, reject in auto unless human
  override. **Disabled entirely in `split_e2e` topology** — the PR cannot see
  app-repo changes, so absence of this signal proves nothing.

---

## Repo topology

Declared per consumer via `ORACLE_TEST_REPO_TOPOLOGY` env var. Three values.

| Topology | Description | Stack-frame signals | PR-diff signals | Auto mode permitted? |
|---|---|---|---|---|
| `monorepo_unit` | Tests import product code directly | Full — `stack_in_app_source` hard pin fires reliably | Full | Yes |
| `monorepo_e2e` | Tests drive a browser against same-repo app | Weak — stack rarely traverses into product; rely on browser-pageerror when frontend throws | Full | Yes |
| `split_e2e` | Tests in separate repo from app under test | Weakest — same as monorepo_e2e for stack, plus PR diff signals disabled | Disabled | **No in Phase 1 — propose mode only** |

### Topology-specific thresholds

| Setting | monorepo_unit | monorepo_e2e | split_e2e |
|---|---|---|---|
| `sourceConfidenceForAuto` | 0.70 | 0.75 | n/a (no auto) |
| `totalSourceEvidenceForAuto` | 0.50 | 0.60 | n/a (no auto) |
| `repairabilityConfidenceForAuto` | 0.70 | 0.70 | n/a (no auto) |
| `stack_in_app_source` hard pin | enabled | enabled (rarely fires) | enabled (rarely fires) |
| `browser_pageerror_in_product` hard pin | n/a | enabled | enabled (provenance check stricter) |
| `productModificationGuard` | enabled | enabled | **disabled** |
| Auto mode | available | available | **unavailable in Phase 1** |

### Topology validation

`ORACLE_TEST_REPO_TOPOLOGY` is a declaration that must be verified, not just
trusted. Three states:

```
full:
  - declared topology checks pass, including historical PR context
    with files in PRODUCT_SOURCE_PATTERNS at least once
  → topologyAllowsAuto can be true (subject to other gates)

partial:
  - declared topology checks pass for structure (paths resolve, excludes apply)
  - BUT no historical CI run yet proves app-change visibility
  → topologyAllowsAuto = false
  → emit topology_app_change_visibility_unproven warning
  → re-validate on each Oracle run; upgrade to full once a PR context with
    PRODUCT_SOURCE_PATTERNS overlap is observed

failed:
  - structural checks fail (no allowedEditPaths resolve, OR
    monorepo declared but PRODUCT_SOURCE_PATTERNS resolves to zero)
  → topologyAllowsAuto = false
  → emit topology_misdeclaration_suspected error
  → does not auto-upgrade; requires operator config fix
```

The `partial` state preserves safety for brand-new repos without blocking
onboarding indefinitely.

Cross-repo deploy correlation is identified as a future signal (Phase 4+)
that could unblock `split_e2e` auto mode by detecting when the deployed app
version changed between failing and last-passing runs.

---

## Resolution algorithm

1. Detect topology from `ORACLE_TEST_REPO_TOPOLOGY`; run topology validation;
   load topology-specific thresholds.
2. Compute role-based stack signals (respecting topology — split_e2e ignores
   PR-derived signals).
3. Compute error pattern signals.
4. Compute cross-test correlation paired check.
5. Compute repairability signals from ARIA-vs-locator comparison.
6. Compute PR safety guards (productModificationGuard skipped in split_e2e).
7. Compute hard negative guards.
8. **Hard pin resolution:** if any source-attribution pinning signal fired,
   source = its attribution, sourceConfidence = 0.95.
9. **Hard pin conflict:** if multiple disagree, failureSource = unknown,
   sourceConfidence = 0.7, `hard_pin_conflict` guard fires.
10. **Weighted sum fallback:** sum per-source weights; winner is highest.
    `sourceConfidence = winnerScore / totalWeight`, capped at 0.95.
11. **Margin guard:** if `(winner − runnerUp) / total < 0.20`, return unknown.
12. **Total evidence floor:** check `totalSourceEvidenceWeight >=
    topology-specific floor` separately at the gate, not during resolution.
13. Emit DetectionResult with all audit fields populated.

---

## Defaults

### PRODUCT_SOURCE_PATTERNS (monorepo topologies; ignored in split_e2e)

```
include:
  app/**, src/**, lib/**, packages/*/src/**

exclude:
  **/*.spec.*, **/*.test.*, **/__tests__/**,
  src/test-utils/**, src/generated/**, **/generated/**,
  **/vendor/**, **/fixtures/**, **/page-objects/**
```

### allowedEditPaths

```
tests/**, e2e/**, playwright/**,
page-objects/**, fixtures/**, test-utils/**,
src/**/__tests__/**, src/**/*.spec.*, src/**/*.test.*
```

### PLAYWRIGHT_INTERNALS (ignored as source evidence)

```
node_modules/playwright/**, node_modules/@playwright/**
```

### Other defaults

- **Glob matcher:** `picomatch` (pinned to avoid implementation divergence)
- **Source-map provenance trust:** default low; trusted requires source map
  present + repo-relative normalization + not under transient directories
- **Hard-pin conflict:** force unknown (hold/reject)
- **Unknown in auto mode:** no approved queue entry

---

## Routing matrix

Top-to-bottom, first match wins. `effectiveMode` is `propose` whenever
`topologyAllowsAuto == false`, regardless of `ORACLE_AUTOFIX_MODE`.

| Condition | Action | Reason |
|---|---|---|
| category in {REGRESSION, NEW_BUG, ENV_ISSUE} | reject | category_not_autofix_eligible |
| testHistory.runCount < 3 | reject | insufficient_history |
| selfModificationGuard fired | reject | pr_context_test_owned_code_modified |
| any hard negative guard fired | reject | hard_negative_<name> |
| productModificationGuard fired AND effectiveMode == auto | reject | pr_context_product_modified |
| productModificationGuard fired AND effectiveMode == propose | hold | pr_context_product_modified |
| failureSource == app_code | reject | source_attribution_app_code |
| failureSource == environment | reject | source_attribution_environment |
| failureSource == unknown AND effectiveMode == auto | reject | source_unknown_in_auto_mode |
| failureSource == unknown AND effectiveMode == propose | hold | source_attribution_unknown |
| history rule fix_decay tripped | hold | history:fix_decay_suspected |
| history rule pending_heal_pr tripped | reject | history:heal_pr_pending |
| history rule failed_pattern tripped | reject | history:agent_fix_failure_pattern |
| ORACLE_AUTOFIX_MODE == off | reject | mode_off |
| queueCount >= maxAutoHealsAllowed | hold | history:rate_limit_per_run |
| repairabilityKind == null OR not AUTO_ELIGIBLE | hold | repairability_insufficient |
| repairabilityKind == locator_drift_user_visible_text | hold (propose) / reject (auto) | repairability_user_visible_change |
| repairabilityConfidence < 0.70 | hold | repairability_confidence_low |
| sourceConfidence < topology threshold | hold | source_confidence_low |
| totalSourceEvidenceWeight < topology floor | hold | source_evidence_insufficient |
| effectiveMode == propose | hold | mode_propose |
| (else, effectiveMode == auto) | approve | policy:auto-approved |

---

## Validation methodology — two-tier

### Tier 1 — ship detector in propose mode

- ≥200 manually-labeled historical failures from aisle-checker-api (declare
  its topology before labeling)
- Blind labeling, two independent labelers, adjudication, inter-rater
  agreement reported
- Detector and LLM outputs hidden during labeling
- Required:
  - ≥90% source-label accuracy
  - ≤2% wrong-confident rate
  - **zero auto-eligible candidates that humans labeled REGRESSION or NEW_BUG**
- Topology-specific: in monorepo_e2e or split_e2e, accept lower stack-signal
  coverage as expected; do not penalize accuracy for "unknown" outcomes when
  signals genuinely don't fire

### Tier 2 — promote to auto mode per repo (monorepo topologies only in Phase 1)

- ≥500 propose-mode decisions reviewed by humans
- Sustained ≥90% source-label accuracy over last 200 decisions
- **Zero observed REGRESSION/NEW_BUG escapes into approved autofix candidates
  over the full validation set**
- Repeat per-repo before enabling auto mode
- `split_e2e` repos cannot be promoted in Phase 1; require Phase 4+
  cross-repo deploy correlation work first

---

## Implementation sequence

### Phase 0 — COMPLETE (PASSED 2026-05-18)

See the "Phase 0 results" section near the top of this doc for the verdict
table and reconciliation findings. Original scope below is preserved for
historical reference. Phase 1 may now begin.

Expanded scope: validated the full artifact supply chain, not just the ARIA
classifier.

1. **Topology declaration + validation**
   - Confirm aisle-checker's topology (likely monorepo_e2e)
   - Run topology validation against real aisle-checker config
   - Result: full / partial / failed

2. **Artifact supply chain end-to-end**
   - Custom Playwright reporter produces prompt.md per failure
   - prompt.md contains a valid ARIA snapshot for ≥95% of failures in a
     sample of 50 real failures
   - Locator parsing handles ≥95% of real Playwright error messages
   - Browser pageerror events captured and exported when frontend JS throws
   - Source-map provenance check correctly identifies trusted vs untrusted
     paths for the bundled JS aisle-checker actually ships
   - Repo-relative path normalization handles aisle-checker's actual
     monorepo layout

3. **ARIA-aware locator-drift classifier spike**
   - All four sub-kinds (data_testid / css_class / user_visible_text /
     dom_structure) distinguishable from real ARIA snapshots
   - At least 20 hand-crafted test cases per sub-kind, plus 50 real
     historical failures across the four kinds

4. **Repo conventions vs proposed defaults**
   - PRODUCT_SOURCE_PATTERNS exclusions match aisle-checker's reality
   - allowedEditPaths matches aisle-checker's reality
   - If mismatch, propose updated defaults or update aisle-checker conventions

**Exit criteria for unblocking Phase 1:**
- Topology validation PASSES for aisle-checker
- Artifact supply chain works end-to-end on ≥95% of a 50-failure sample
- Locator-drift classifier hits ≥85% per-sub-kind accuracy on the test set
- Defaults reconciled

If any of these fails: revisit design, do not start Phase 1.

Estimated effort: ~2 weeks.

### Phase 1 — READY TO START (Oracle additive, mode=off default)

- Detector module split: source-attribution and repairability functions
  separate
- Topology detection from env var; topology-specific thresholds
- Topology validation (full/partial/failed) at startup and every run
- Path normalization + source-map provenance trust scoring
- Role-based stack-frame classification
- Browser-pageerror signal extraction (for E2E topologies)
- Repairability kind detection via ARIA-vs-locator structural comparison
- Hard negative guards including new `artifact_trust_insufficient_for_auto`
  and `ambiguous_repair_target`
- PR safety guards as routing matrix rows (with split_e2e exclusion)
- History suppression-only
- Cross-test correlation requires paired infra-error signal
- Table-driven tests: every repairability sub-kind, every hard negative
  guard, every gate condition, REGRESSION-never-queued invariant, split_e2e
  auto-disabled invariant
- 200-failure labeling exercise validates Tier 1 thresholds for
  aisle-checker's topology

### Phase 2

Queue artifact + propose mode in aisle-checker.

### Phase 3

Auto mode for monorepo topologies only (per-repo, gated on Tier 2).

### Phase 4

PR lifecycle tracking + dashboards + cross-repo deploy correlation (the
unblocker for split_e2e auto mode).

### Phase 5

Cross-repo rollout (propose mode first; split_e2e stays propose-only until
Phase 4 lands).

---

## Decision log (why these choices, what was rejected)

### Why split source attribution from repairability

Originally considered as a single dimension ("can this be autofixed?").
Codex review round 2 flagged that `failureSource = test_code` is necessary
but not sufficient — a test fixture bug is test-code but not safely
auto-fixable. Splitting forces the gate to require positive repairability
evidence in addition to "not app/env code." This catches generic timeouts
that would otherwise be silently auto-healed.

### Why structural detector with no LLM

Codex review round 1 flagged that having both `category` and `failureSource`
come from the same LLM made the two-layer gating theatre — errors correlate.
Computing `failureSource` from structural signals (stack frames, regex,
ARIA-vs-locator) keeps the two layers genuinely independent.

### Why four locator-drift sub-kinds

Originally "locator_drift_with_similar_aria_element" as a single category.
Codex review round 3 identified this as the sharpest remaining safety
weakness: a real product UI change (button renamed) presents identically to
a test-side selector drift. Splitting into four sub-kinds lets us auto-heal
data-testid changes (test-infrastructure) while holding user-visible text
changes (could be regression).

### Why history is advisory only

Originally `agentFixAppliedCount >= 2 → test_code` was a source-positive
signal. Codex round 3 caught the circularity: history is downstream of prior
Oracle/healer decisions, so source-positive use creates a feedback loop where
bad prior heals amplify future heals. History now feeds suppression rules
only.

### Why PR diff is a safety guard, not a source signal

Originally PR diff overlap contributed to source attribution. Codex round 3
flagged that touching product code does not prove the failure source is
app_code (could be coincidental), and touching test code does not prove
test_code. PR diff is now a separate safety guard: touching test-owned code
forbids auto-heal entirely (self-modification); touching product code holds
in propose, rejects in auto.

### Why split_e2e cannot have auto mode in Phase 1

The strongest source-attribution signals (stack frames in product source,
PR diff overlap) are unavailable when tests live in a different repo from
the app. Defense-in-depth degrades to near-single-layer. Until cross-repo
deploy correlation provides an independent app-change signal (Phase 4+),
auto mode is unsafe for split_e2e. Propose mode remains useful — it
generates queue entries and tracks labels, just doesn't auto-approve.

### Why topology validation has a "partial" state

Brand-new repos cannot prove app-change visibility because they have no
historical PR context yet. Forcing them to "failed" would block onboarding
forever; trusting their declaration without verification creates the
topology-misdeclaration trap (split_e2e flagged as monorepo_e2e). The
`partial` state preserves safety (topologyAllowsAuto = false) while allowing
upgrade to `full` as history accumulates.

### Why assertion-removal check is downstream, not detector-time

The detector cannot inspect a patch that doesn't exist yet. Assertion
weakening must be checked in the healer's CI verification step by parsing
the test file AST before and after the proposed patch. This is the healer's
responsibility, documented in the autofix flow design (separate doc).

---

## Out of scope (settled, do not re-debate)

These were settled across the four design review rounds. Future revisions
must justify reopening them.

- Autofix flow architecture (queue artifact shape, CI orchestration, healer
  integration, PR handling) — finalized
- Whether to separate source attribution from repairability — yes
- Whether to use LLM for failureSource — no, structural only
- Whether REGRESSION/NEW_BUG can ever enter the queue — no, hard-rejected at
  gate 1
- Whether PR overlap is source signal or safety guard — safety guard
- Whether history is source-positive or advisory — advisory only
- Whether locator drift needs sub-kinds — yes, four sub-kinds
- Whether repo topology matters — yes, three topologies
- Whether split_e2e gets auto mode in Phase 1 — no, propose only
- TestHealer / agent internals — black box
- LLM category classifier itself — assumed unchanged

---

## Open questions / future work

- **Cross-repo deploy correlation** (Phase 4+): the missing signal that
  would unblock split_e2e auto mode. Requires:
  - App exposes version endpoint (`/version`, git SHA in HTML meta tag, etc.)
  - Test runner captures version per run, writes to test report
  - Oracle reads captured version, stores on run record
  - On next run, compare to prior passing-run version; if different, emit
    strong app_code signal
- **Per-test trust scoring**: tests that have been stable for >N runs could
  have lower autofix barriers. Not in scope until we have run-history data
  to back the heuristic.
- **`monorepo_mixed` topology**: per-failure topology inference (some tests
  unit, some E2E in same repo). Currently handled by always classifying as
  monorepo_e2e (more conservative). Revisit if a consumer needs unit-test
  auto-heal alongside E2E.
- **Healer accuracy feedback loop**: when a heal is marked applied but the
  test fails again with the same fingerprint within 30 days, log as
  `misclassification_suspected`. Not strictly Phase 1 but the data
  collection needs to start with Phase 2 to be useful later.

---

## Codex review history

Four review rounds across this design:

1. **Round 1** — original gating proposal with category + failureSource.
   Found: signals correlated because both LLM-derived. Action: pivot to
   structural detector for failureSource.

2. **Round 2** — structural detector added. Found: positive repairability
   evidence missing; "not app_code" not sufficient. Action: separate
   repairability dimension with AUTO_ELIGIBLE_KINDS.

3. **Round 3** — repairability added. Found: locator-drift framing too
   coarse; real UI changes look identical to selector drift; PR diff is not
   source signal; history circular. Action: four locator-drift sub-kinds; PR
   diff demoted to safety guard; history advisory only.

4. **Round 4** — gating contract refinement. Found: `productModificationGuard`
   absent from gate contract; missing artifact-trust guard; topology
   misdeclaration unprotected; Phase 0 scope insufficient. Verdict: GO WITH
   CONDITIONS. Conditions addressed in this doc.

Codex review prompts are not committed (they're tools for ongoing reviews
rather than design artifacts). Re-derive when running new reviews; the
historical prompts are in the design-conversation transcript.
