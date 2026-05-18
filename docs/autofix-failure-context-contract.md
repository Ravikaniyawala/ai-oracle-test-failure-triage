# Autofix failure-context contract

Oracle's autofix detector consumes per-failure artifacts written by the
consumer's Playwright reporter. This doc pins the contract so reporters
can be implemented and updated against a stable target.

## Where Oracle looks

`ORACLE_FAILURE_CONTEXT_PATH` (default: `test-results/failure-context`).

Inside that directory, **one subdirectory per failure**, named by a
slug of the test identity (any string — Oracle does not parse the
subdir name). Inside each subdirectory, a single `data.json` file.

```
test-results/failure-context/
├── chromium__tests-checkout-spec-ts__add-to-cart/
│   ├── data.json
│   ├── prompt.md            (optional, healer reads this)
│   ├── aria.txt             (optional, raw ARIA dump)
│   ├── screenshot.png       (optional)
│   └── trace.zip            (optional)
├── chromium__tests-login-spec-ts__sign-in/
│   └── data.json
└── ...
```

## `data.json` schema

```ts
{
  // ── Test identity (at least ONE pair must be present) ──────────────────────
  "testName":          "Suite > test name",       // Oracle canonical form
  "errorHash":         "abc123",                  // 12-char hex
  // OR fallback:
  "testFile":          "tests/checkout.spec.ts",
  "testTitle":         "add to cart",

  // ── Failure context ────────────────────────────────────────────────────────
  "errorMessage":      "TimeoutError: locator.click ...",

  // ── ARIA snapshot ──────────────────────────────────────────────────────────
  // YAML-like format matching Playwright's "Copy prompt" output.
  // See "ARIA format" section below.
  "ariaSnapshot":      "- button \"Checkout\" [data-test=checkout-btn]\n- ...",

  // ── Trust level ────────────────────────────────────────────────────────────
  // "trusted"   — stack frames resolved to repo-local source; safe for auto
  // "partial"   — some frames untrusted; auto rejects, propose holds
  // "untrusted" — bundled/vendor frames only; auto rejects
  "artifactTrustLevel": "trusted",

  // ── Optional artifact pointers (carried into queue artifact) ──────────────
  "promptMdPath":      "test-results/failure-context/<slug>/prompt.md",
  "screenshotPath":    "test-results/failure-context/<slug>/screenshot.png",
  "tracePath":         "test-results/failure-context/<slug>/trace.zip"
}
```

### Required fields

Only `artifactTrustLevel` and either `(testName + errorHash)` or
`(testFile + testTitle)` are required. Everything else is optional and
gracefully degrades:

| Missing field | Detector behavior |
|---|---|
| `ariaSnapshot` | Drift classifier returns `kind=null` → policy holds (no ARIA = no drift evidence) |
| `errorMessage` | Locator parser returns null → contributes no signal |
| `artifactTrustLevel` | Defaults to `untrusted` → auto-mode auto-rejects via hard guard |
| both identity pairs | Entry is logged as `skipped` and ignored |

## ARIA format

Each line represents one element. Indentation is preserved but not
required (the parser flattens — see Limitations below). Format:

```
- <role> "<accessible-name>" [<attr=value> <attr=value> ...]
```

Examples:

```yaml
- button "Checkout"
- button "Save" [disabled]
- heading "Welcome" [level=1]
- link "Sign in"
- list:
  - listitem "Product A - $10.00"
  - listitem "Product B - $20.00"
- button "Checkout" [data-test=checkout-btn data-qa=checkout]
```

### What the parser captures

- `role` (mandatory) — first token after the leading `-`
- `name` (optional) — quoted string after the role
- `testAttributes` — only `data-*` attributes (`data-test`,
  `data-testid`, `data-qa`, `data-cy`, etc.) inside `[...]`. Other
  bracketed attributes like `[disabled]` or `[level=1]` are recognized
  but ignored.

### What the parser does NOT capture (today)

- CSS class names (no `.class` syntax in the format)
- DOM-path signatures
- Text content separate from accessible name

A richer reporter may extend the format; the parser ignores unknown
attributes safely.

## Trust-level derivation

Reporters should compute `artifactTrustLevel` from the stack frames
they captured:

- All user frames in repo-local source (`.ts`, `.tsx`, `.js`, etc.) → `trusted`
- All user frames in `node_modules` / bundled assets → `untrusted`
- Mix of trusted and untrusted → `partial`

Phase 0's reporter spike has a `deriveTrustLevel()` helper that
implements this rule.

## Reporter implementation reference

A working reference reporter lives in `aisle-checker-api-tests-ai-triage`
at `tests/e2e/oracle-phase0/reporter/prompt-reporter.ts`. It hooks into
Playwright's reporter API, captures `prompt.md` + `data.json` per
failure, and writes to `test-results/failure-context/<slug>/`.

To adopt in another repo, add to `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [
    ['list'],
    ['junit', { outputFile: 'playwright-results/results.xml' }],
    ['./path/to/oracle-prompt-reporter.ts', {
      outputDir: 'test-results/failure-context',
    }],
  ],
})
```

The reporter is opt-in — repos without it see Oracle's detector route
all candidates to `held` because no ARIA evidence is available, which
is the safe degraded behavior.

## Compatibility guarantee

The contract is `schemaVersion 1` (implicit — versioning will be added
to `data.json` in a follow-up). Future fields will be additive and
optional. Removing or renaming fields is a breaking change and will
bump a schema version.

## Out of scope

- **Trace extraction**: Oracle does NOT read `trace.zip`. The reporter
  is responsible for extracting ARIA from the trace and serializing it
  in the format above. This keeps Oracle's dependency surface small
  and lets reporters use whichever Playwright internals are available
  in their version.
- **PR-status tracking**: tracked separately (Phase 4).
- **Cross-repo deploy correlation**: tracked separately (Phase 4+).
