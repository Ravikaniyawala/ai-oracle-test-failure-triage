import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as detector from '../../src/autofix-detector/index.js';

describe('autofix-detector barrel exports', () => {
  it('exports the four core pure functions', () => {
    assert.equal(typeof detector.parseFailingLocator, 'function');
    assert.equal(typeof detector.parseLocatorExpression, 'function');
    assert.equal(typeof detector.classifyLocatorDrift, 'function');
    assert.equal(typeof detector.normalizePath, 'function');
    assert.equal(typeof detector.classifyFrameProvenance, 'function');
    assert.equal(typeof detector.buildNormalizedFrame, 'function');
    assert.equal(typeof detector.validateTopology, 'function');
    assert.equal(typeof detector.topologyAllowsAuto, 'function');
  });

  it('exposes default constants (Phase 0 reconciliation findings applied)', () => {
    assert.ok(detector.DEFAULT_TEST_ATTRIBUTE_NAMES.includes('data-test'),
      'data-test must be in defaults (aisle-checker uses it)');
    assert.ok(detector.DEFAULT_TEST_ATTRIBUTE_NAMES.includes('data-testid'),
      'data-testid must be in defaults');
    assert.ok(detector.DEFAULT_ALLOWED_EDIT_PATHS.includes('page-objects/**'),
      'both page-object conventions must be in defaults');
    assert.ok(detector.DEFAULT_ALLOWED_EDIT_PATHS.includes('tests/**/pages/**'),
      'aisle-checker-style page-objects path must be in defaults');
    assert.ok(detector.DEFAULT_ALLOWED_EDIT_PATHS.includes('fixtures/**'));
    assert.ok(detector.DEFAULT_ALLOWED_EDIT_PATHS.includes('tests/**/fixtures/**'));
    assert.ok(detector.DEFAULT_PRODUCT_SOURCE_PATTERNS.include.includes('apps/*/src/**'),
      'apps/*/src/** must be in PRODUCT_SOURCE_PATTERNS (aisle-checker layout)');
  });

  it('AUTO_ELIGIBLE_REPAIRABILITY_KINDS contains exactly the four safe kinds', () => {
    const set = detector.AUTO_ELIGIBLE_REPAIRABILITY_KINDS;
    assert.equal(set.size, 4);
    assert.ok(set.has('locator_drift_data_testid_only'));
    assert.ok(set.has('strict_mode_selector_ambiguity'));
    assert.ok(set.has('page_object_selector_drift_isolated'));
    assert.ok(set.has('known_playwright_api_misuse'));
    // Negative: user-visible text drift must NOT be auto-eligible
    assert.ok(!set.has('locator_drift_user_visible_text' as never));
  });

  it('DEFAULT_TOPOLOGY_THRESHOLDS disallows auto for split_e2e (Phase 1 invariant)', () => {
    assert.equal(detector.DEFAULT_TOPOLOGY_THRESHOLDS.split_e2e.autoModePermitted, false);
    assert.equal(detector.DEFAULT_TOPOLOGY_THRESHOLDS.monorepo_unit.autoModePermitted, true);
    assert.equal(detector.DEFAULT_TOPOLOGY_THRESHOLDS.monorepo_e2e.autoModePermitted, true);
  });

  it('topology thresholds tighten as topology weakens', () => {
    const t = detector.DEFAULT_TOPOLOGY_THRESHOLDS;
    // monorepo_e2e thresholds must be at least as strict as monorepo_unit
    assert.ok(t.monorepo_e2e.sourceConfidenceForAuto >= t.monorepo_unit.sourceConfidenceForAuto);
    assert.ok(t.monorepo_e2e.totalSourceEvidenceForAuto >= t.monorepo_unit.totalSourceEvidenceForAuto);
  });
});
