/**
 * Pure verdict-resolution logic for the Oracle triage workflow.
 *
 * This module is the authoritative implementation of the DEGRADED verdict
 * mapping.  The identical logic is mirrored in the "Determine verdict"
 * workflow step of .github/workflows/oracle-triage.yml (inline Node.js).
 * Tests in tests/verdict-resolver.test.ts cover both the normal and
 * degraded paths.
 *
 * Verdict semantics:
 *   CLEAR    — all failures are FLAKY or ENV_ISSUE; pipeline may deploy.
 *   BLOCKED  — at least one REGRESSION or NEW_BUG; pipeline is blocked.
 *   DEGRADED — Oracle itself failed (API error, parse failure, etc.).
 *              Not a classification result — indicates provider failure.
 *              Mapped to CLEAR or BLOCKED depending on triage-failure-mode.
 */

export type RawVerdict  = 'CLEAR' | 'BLOCKED' | 'DEGRADED' | (string & {});
export type FailureMode = 'fail-closed' | 'pass-through';

/**
 * Resolve the raw verdict read from oracle-verdict.json into the effective
 * workflow output verdict.
 *
 * Rules:
 *   - DEGRADED + pass-through  → CLEAR   (Oracle failure is informational only)
 *   - DEGRADED + fail-closed   → BLOCKED (Oracle failure blocks the pipeline)
 *   - CLEAR / BLOCKED          → unchanged
 *   - missing / empty          → BLOCKED (safe fallback)
 */
export function resolveVerdict(rawVerdict: RawVerdict, failureMode: FailureMode): string {
  if (rawVerdict === 'DEGRADED') {
    return failureMode === 'pass-through' ? 'CLEAR' : 'BLOCKED';
  }
  return rawVerdict || 'BLOCKED';
}
