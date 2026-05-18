/**
 * Autofix detector — barrel exports.
 *
 * The detector emits `failureSource` and `repairabilityKind` from
 * structural, non-LLM signals. See `docs/autofix-design.md` for the full
 * design.
 *
 * Phase 1 ships this as a pure-function library with zero runtime
 * coupling to the rest of Oracle. Phase 2 wires it into the policy
 * engine + action gating; Phase 3 emits the queue artifact.
 *
 * Phase 0 reconciliation findings are baked in:
 *   - `DEFAULT_TEST_ATTRIBUTE_NAMES` includes `data-test` (aisle-checker)
 *     alongside `data-testid`, `data-qa`, `data-cy`.
 *   - `DEFAULT_ALLOWED_EDIT_PATHS` covers both page-objects and
 *     tests-pages glob conventions; same for fixtures.
 *   - `DEFAULT_PRODUCT_SOURCE_PATTERNS` includes the apps-src glob for
 *     monorepo layouts like aisle-checker.
 */

export {
  AUTO_ELIGIBLE_REPAIRABILITY_KINDS,
  DEFAULT_ALLOWED_EDIT_PATHS,
  DEFAULT_PLAYWRIGHT_INTERNAL_PATHS,
  DEFAULT_PRODUCT_SOURCE_PATTERNS,
  DEFAULT_TEST_ATTRIBUTE_NAMES,
  DEFAULT_TOPOLOGY_THRESHOLDS,
} from './types.js';

export type {
  AriaSnapshotElement,
  ArtifactTrustLevel,
  FailureSource,
  HardGuard,
  LocatorDriftClassification,
  LocatorDriftKind,
  LocatorExpressionKind,
  NormalizedStackFrame,
  ParsedLocator,
  RepairabilitySignal,
  RepoTopology,
  SourceSignal,
  StackFrameProvenance,
  TopologyState,
  TopologyThresholds,
  TopologyValidationResult,
} from './types.js';

export { normalizePath, type PathNormalizationResult } from './path-normalizer.js';
export {
  buildNormalizedFrame,
  classifyFrameProvenance,
  type ProvenanceInput,
  type ProvenanceVerdict,
} from './provenance-checker.js';
export { parseFailingLocator, parseLocatorExpression } from './locator-parser.js';
export { classifyLocatorDrift, type ClassifierInput } from './locator-drift-classifier.js';
export {
  topologyAllowsAuto,
  validateTopology,
  type TopologyValidatorOptions,
} from './topology-validator.js';
