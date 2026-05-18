/**
 * Autofix detector types — Phase 1 canonical schema.
 *
 * Mirrors the design in `docs/autofix-design.md`. Kept in its own module
 * so the top-level `src/types.ts` stays focused on triage primitives.
 *
 * Phase 0 reconciliation findings baked in:
 *   - `testAttributeNames` is configurable (aisle-checker uses `data-test`)
 *   - `allowedEditPaths` defaults cover both `page-objects/` glob and
 *     `tests/.../pages/` glob conventions (see DEFAULT_ALLOWED_EDIT_PATHS)
 */

// ── Repo topology ────────────────────────────────────────────────────────

export type RepoTopology = 'monorepo_unit' | 'monorepo_e2e' | 'split_e2e';

export type TopologyState = 'full' | 'partial' | 'failed';

export interface TopologyValidationResult {
  declared:                    RepoTopology;
  state:                       TopologyState;
  validationFailures:          string[];
  validationWarnings:          string[];
  resolvedAllowedEditPaths:    string[];
  resolvedProductSourcePaths:  string[];
  appChangeVisibilityProven:   boolean;
}

// ── Locator parser ───────────────────────────────────────────────────────

export type LocatorExpressionKind =
  | 'getByTestId'
  | 'getByRole'
  | 'getByText'
  | 'getByLabel'
  | 'getByPlaceholder'
  | 'css_selector'
  | 'attribute_selector'
  | 'unknown';

export interface ParsedLocator {
  raw:            string;
  kind:           LocatorExpressionKind;
  testAttribute?: string;
  value?:         string;
  cssSelector?:   string;
  confidence:     number;
}

// ── Stack-frame normalization / provenance ───────────────────────────────

export type StackFrameProvenance = 'trusted' | 'untrusted';

export interface NormalizedStackFrame {
  raw:        string;
  file:       string;
  normalized: string;
  line?:      number;
  column?:    number;
  provenance: StackFrameProvenance;
  reason:     string;
}

// ── Locator-drift classifier ─────────────────────────────────────────────

export type LocatorDriftKind =
  // Auto-eligible
  | 'locator_drift_data_testid_only'
  | 'strict_mode_selector_ambiguity'
  | 'page_object_selector_drift_isolated'
  | 'known_playwright_api_misuse'
  // Hold/reject
  | 'locator_drift_css_class_only'
  | 'locator_drift_user_visible_text'
  | 'locator_drift_dom_structure'
  | 'syntax_or_import_error'
  | 'fixture_data_drift'
  | 'snapshot_mismatch';

export const AUTO_ELIGIBLE_REPAIRABILITY_KINDS: ReadonlySet<LocatorDriftKind> = new Set<LocatorDriftKind>([
  'locator_drift_data_testid_only',
  'strict_mode_selector_ambiguity',
  'page_object_selector_drift_isolated',
  'known_playwright_api_misuse',
]);

export interface AriaSnapshotElement {
  role:            string;
  name?:           string;
  testAttributes?: Record<string, string>;
  classes?:        string[];
  pathSignature?:  string;
  text?:           string;
}

export interface LocatorDriftClassification {
  kind:       LocatorDriftKind | null;
  confidence: number;
  candidate?: AriaSnapshotElement;
  reasoning:  string;
}

// ── Detector output ──────────────────────────────────────────────────────

export type FailureSource = 'test_code' | 'app_code' | 'environment' | 'unknown';
export type ArtifactTrustLevel = 'trusted' | 'partial' | 'untrusted';

export interface SourceSignal {
  kind:       string;
  source:     FailureSource;
  weight:     number;
  pinning:    boolean;
  detail:     string;
}

export interface RepairabilitySignal {
  kind:    string;
  detail:  string;
  weight:  number;
}

export type HardGuard =
  | 'value_mismatch'
  | 'http_status_mismatch'
  | 'product_source_frame_with_trusted_provenance'
  | 'environment_hard_pin'
  | 'changed_test_owned_dependency_in_pr'
  | 'missing_or_unsafe_artifact_path'
  | 'hard_pin_conflict'
  | 'artifact_trust_insufficient_for_auto'
  | 'ambiguous_repair_target'
  | 'missing_or_incomplete_aria_for_locator_repairability';

// ── Defaults (with Phase 0 reconciliation findings applied) ─────────────

/**
 * Default test-attribute names the locator-drift classifier treats as
 * test-infrastructure (not product behavior). Phase 0 reconciliation
 * confirmed aisle-checker uses `data-test`; the upstream default set must
 * include both `data-test` and `data-testid` plus common alternatives.
 */
export const DEFAULT_TEST_ATTRIBUTE_NAMES: readonly string[] = [
  'data-test',
  'data-testid',
  'data-qa',
  'data-cy',
];

/**
 * Default allowedEditPaths for the autofix detector's self-modification
 * guard and locator-drift "page object isolated" repairability check.
 *
 * Phase 0 reconciliation: keep BOTH page-objects glob and
 * tests-pages glob conventions. The first covers conventions like
 * `apps/foo/page-objects/`; the second covers aisle-checker style
 * `tests/e2e/src/pages/`. Same logic for fixtures.
 */
export const DEFAULT_ALLOWED_EDIT_PATHS: readonly string[] = [
  // Top-level test directories
  'tests/**',
  'e2e/**',
  'playwright/**',
  // Page-object conventions (both styles)
  'page-objects/**',
  'tests/**/pages/**',
  // Fixture conventions (both styles)
  'fixtures/**',
  'tests/**/fixtures/**',
  // Test utility conventions
  'test-utils/**',
  'tests/**/test-utils/**',
  // Co-located test files inside src trees
  'src/**/__tests__/**',
  'src/**/*.spec.*',
  'src/**/*.test.*',
];

/**
 * Default PRODUCT_SOURCE_PATTERNS (monorepo topologies only).
 *
 * Phase 0 reconciliation: include the apps-src glob for monorepo layouts
 * like aisle-checker that nest apps under `apps/<app>/src/`.
 */
export const DEFAULT_PRODUCT_SOURCE_PATTERNS = {
  include: [
    'app/**',
    'src/**',
    'lib/**',
    'packages/*/src/**',
    'apps/*/src/**',
  ],
  exclude: [
    '**/*.spec.*',
    '**/*.test.*',
    '**/__tests__/**',
    'src/test-utils/**',
    'src/generated/**',
    '**/generated/**',
    '**/vendor/**',
    '**/fixtures/**',
    '**/page-objects/**',
    'apps/*/dist/**',
  ],
} as const;

export const DEFAULT_PLAYWRIGHT_INTERNAL_PATHS: readonly string[] = [
  'node_modules/playwright/**',
  'node_modules/@playwright/**',
];

/**
 * Topology-specific thresholds for the autofix gating contract.
 *
 * Source confidence (relative dominance) and total evidence weight
 * (absolute strength) tighten as topology weakens — split_e2e cannot
 * promote to auto in Phase 1 regardless.
 */
export interface TopologyThresholds {
  sourceConfidenceForAuto:        number;
  totalSourceEvidenceForAuto:     number;
  repairabilityConfidenceForAuto: number;
  marginGuard:                    number;
  autoModePermitted:              boolean;
}

export const DEFAULT_TOPOLOGY_THRESHOLDS: Record<RepoTopology, TopologyThresholds> = {
  monorepo_unit: {
    sourceConfidenceForAuto:        0.70,
    totalSourceEvidenceForAuto:     0.50,
    repairabilityConfidenceForAuto: 0.70,
    marginGuard:                    0.20,
    autoModePermitted:              true,
  },
  monorepo_e2e: {
    sourceConfidenceForAuto:        0.75,
    totalSourceEvidenceForAuto:     0.60,
    repairabilityConfidenceForAuto: 0.70,
    marginGuard:                    0.20,
    autoModePermitted:              true,
  },
  split_e2e: {
    // Auto is disallowed in Phase 1 regardless of detector output.
    sourceConfidenceForAuto:        1.00,  // unreachable
    totalSourceEvidenceForAuto:     1.00,  // unreachable
    repairabilityConfidenceForAuto: 1.00,
    marginGuard:                    0.20,
    autoModePermitted:              false,
  },
};
