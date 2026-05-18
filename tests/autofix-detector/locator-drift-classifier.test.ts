import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocatorDrift } from '../../src/autofix-detector/locator-drift-classifier.js';
import { parseLocatorExpression } from '../../src/autofix-detector/locator-parser.js';
import type { LocatorDriftKind } from '../../src/autofix-detector/types.js';
import { HAND_CRAFTED_CASES, ALL_DRIFT_CASES } from './_fixtures-drift-cases.js';

describe('classifyLocatorDrift — basic shape', () => {
  it('returns null kind on empty ARIA snapshot', () => {
    const r = classifyLocatorDrift({
      failingLocator: { raw: 'getByTestId(x)', kind: 'getByTestId', value: 'x', confidence: 0.95 },
      ariaSnapshot:   [],
    });
    assert.equal(r.kind, null);
    assert.equal(r.confidence, 0);
  });

  it('detects user-visible text drift for getByRole + name change', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`getByRole('button', { name: 'Checkout' })`)!,
      ariaSnapshot:   [{ role: 'button', name: 'Place Order' }],
    });
    assert.equal(r.kind, 'locator_drift_user_visible_text');
    assert.ok(r.confidence >= 0.8);
  });

  it('detects data-testid-only drift', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`getByTestId('product-list')`)!,
      ariaSnapshot:   [{
        role: 'list',
        name: 'Products',
        testAttributes: { 'data-test': 'products-list' },
      }],
    });
    assert.equal(r.kind, 'locator_drift_data_testid_only');
  });

  it('detects CSS-class drift', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`locator('.product-card')`)!,
      ariaSnapshot:   [{ role: 'article', name: 'Card', classes: ['product-tile'] }],
    });
    assert.equal(r.kind, 'locator_drift_css_class_only');
  });

  it('detects DOM-structure drift for nth-child selector', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`locator('ul > li:nth-child(2)')`)!,
      ariaSnapshot:   [{ role: 'listitem', name: 'Item' }],
    });
    assert.equal(r.kind, 'locator_drift_dom_structure');
  });

  it('detects DOM-structure drift for :not(), :only-child, deep descendants', () => {
    for (const sel of [
      '.form input:not([type=hidden])',
      '.wrapper :only-child',
      '.app .content .item .price',  // 4-token descendant chain
    ]) {
      const r = classifyLocatorDrift({
        failingLocator: parseLocatorExpression(`locator('${sel}')`)!,
        ariaSnapshot:   [{ role: 'generic', name: 'el' }],
      });
      assert.equal(r.kind, 'locator_drift_dom_structure', `selector ${sel} should classify as dom_structure`);
    }
  });

  it('honors custom testAttributeNames override (Phase 0 reconciliation: data-test)', () => {
    // aisle-checker config: only data-test counts as a test attribute
    const r = classifyLocatorDrift({
      failingLocator:     parseLocatorExpression(`[data-test="product"]`)!,
      ariaSnapshot:       [{
        role: 'list',
        name: 'Products',
        testAttributes: { 'data-test': 'products' },
      }],
      testAttributeNames: ['data-test'],
    });
    assert.equal(r.kind, 'locator_drift_data_testid_only');
  });
});

describe('classifyLocatorDrift — fixture accuracy (Phase 0 corpus)', () => {
  function evalCases(cases: typeof HAND_CRAFTED_CASES) {
    const byKind: Record<LocatorDriftKind, { correct: number; total: number }> = {
      locator_drift_data_testid_only:  { correct: 0, total: 0 },
      locator_drift_css_class_only:    { correct: 0, total: 0 },
      locator_drift_user_visible_text: { correct: 0, total: 0 },
      locator_drift_dom_structure:     { correct: 0, total: 0 },
      strict_mode_selector_ambiguity:  { correct: 0, total: 0 },
      page_object_selector_drift_isolated: { correct: 0, total: 0 },
      known_playwright_api_misuse:     { correct: 0, total: 0 },
      syntax_or_import_error:          { correct: 0, total: 0 },
      fixture_data_drift:              { correct: 0, total: 0 },
      snapshot_mismatch:               { correct: 0, total: 0 },
    };
    const failures: string[] = [];
    for (const c of cases) {
      const parsed = parseLocatorExpression(c.locatorExpression);
      if (!parsed) {
        byKind[c.expectedKind].total++;
        failures.push(`${c.id}: parser returned null`);
        continue;
      }
      const classification = classifyLocatorDrift({
        failingLocator: parsed,
        ariaSnapshot:   c.ariaSnapshot,
        testAttributeNames: c.testAttributeNames,
      });
      byKind[c.expectedKind].total++;
      if (classification.kind === c.expectedKind) {
        byKind[c.expectedKind].correct++;
      } else {
        failures.push(
          `${c.id}: expected ${c.expectedKind}, got ${classification.kind ?? 'null'}`,
        );
      }
    }
    return { byKind, failures };
  }

  it('hand-crafted: ≥85% per active sub-kind', () => {
    const { byKind, failures } = evalCases(HAND_CRAFTED_CASES);
    if (failures.length > 0) console.log('hand-crafted failures (first 10):',
      failures.slice(0, 10).map(f => `\n  - ${f}`).join(''));
    for (const [kind, s] of Object.entries(byKind)) {
      if (s.total === 0) continue;  // skip kinds not in this corpus
      const acc = s.correct / s.total;
      assert.ok(acc >= 0.85, `${kind}: ${(acc * 100).toFixed(1)}% < 85%`);
    }
  });

  it('full set (hand-crafted + synthetic): ≥85% per active sub-kind', () => {
    const { byKind, failures } = evalCases(ALL_DRIFT_CASES);
    if (failures.length > 0) console.log('full-set failures (first 10):',
      failures.slice(0, 10).map(f => `\n  - ${f}`).join(''));
    for (const [kind, s] of Object.entries(byKind)) {
      if (s.total === 0) continue;
      const acc = s.correct / s.total;
      assert.ok(acc >= 0.85, `${kind}: ${(acc * 100).toFixed(1)}% < 85%`);
    }
  });
});
