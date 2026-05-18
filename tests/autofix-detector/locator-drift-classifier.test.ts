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

describe('classifyLocatorDrift — safety regressions (Codex review)', () => {
  // Codex P0 #2: exact-match candidate must NOT classify as drift.
  it('returns null when candidate has the same test-attribute value (no drift)', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`getByTestId('product-list')`)!,
      ariaSnapshot:   [{
        role: 'list',
        name: 'product-list',
        testAttributes: { 'data-test': 'product-list' },  // SAME value
      }],
    });
    assert.equal(r.kind, null);
    assert.equal(r.confidence, 0);
    assert.match(r.reasoning, /no drift|matching test-attribute/);
  });

  // Codex P0 #2: also applies to attribute_selector kind.
  it('returns null when attribute_selector candidate has matching value', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`[data-test="store-card"]`)!,
      ariaSnapshot:   [{
        role: 'article',
        name: 'store-card',
        testAttributes: { 'data-test': 'store-card' },
      }],
    });
    assert.equal(r.kind, null);
  });

  // Codex P0 #1: no weak fallback — unrelated ARIA elements must NOT
  // become auto-eligible candidates for test-id locators.
  it('returns null when no candidate has matching name token AND no matching testid value', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`getByTestId('checkout-btn')`)!,
      ariaSnapshot:   [
        // Unrelated element with a test attribute (would have been picked
        // up by the old `anyWithTestAttr` fallback).
        { role: 'link', name: 'Footer Link', testAttributes: { 'data-test': 'footer-link' } },
      ],
    });
    assert.equal(r.kind, null);
    assert.match(r.reasoning, /no candidate/);
  });

  // Codex P0 #1 corollary: when candidate has no test attributes at all,
  // can't infer drift from current ARIA alone — return null.
  it('returns null when matched candidate has no configured test attributes', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`getByTestId('product-aisle')`)!,
      ariaSnapshot:   [
        // Name matches via token overlap (product-aisle / Aisle A3 share
        // the "aisle" token) BUT no test attributes exist on candidate.
        { role: 'text', name: 'Aisle A3', testAttributes: {} },
      ],
    });
    assert.equal(r.kind, null);
    assert.match(r.reasoning, /no configured test attributes|cannot confidently infer/);
  });

  // Section 4 invariant test: getByTestId locators must NEVER classify
  // as user_visible_text drift, regardless of the candidate's name.
  // Current ARIA name alone is insufficient evidence of text drift —
  // the classifier has no prior visible name to compare against.
  it('INVARIANT: getByTestId NEVER returns locator_drift_user_visible_text', () => {
    // Try several shapes where a naive classifier might be tempted to
    // infer text drift from candidate.name.
    const cases = [
      // Candidate name completely different from the testid value
      {
        loc: `getByTestId('checkout-btn')`,
        aria: [{ role: 'button', name: 'Place Order',
                 testAttributes: { 'data-test': 'place-order-btn' } }],
      },
      // Candidate name superficially related but text "changed"
      {
        loc: `getByTestId('signin-form')`,
        aria: [{ role: 'form', name: 'Login form',
                 testAttributes: { 'data-test': 'login-form' } }],
      },
      // No test attributes at all
      {
        loc: `getByTestId('product-aisle')`,
        aria: [{ role: 'text', name: 'Section B' }],
      },
    ];
    for (const c of cases) {
      const r = classifyLocatorDrift({
        failingLocator: parseLocatorExpression(c.loc)!,
        ariaSnapshot:   c.aria,
      });
      assert.notEqual(
        r.kind, 'locator_drift_user_visible_text',
        `getByTestId locator ${c.loc} must not classify as user_visible_text drift`,
      );
    }
  });

  // Section 4 invariant: same rule applies to attribute_selector locators
  // that target configured test attributes.
  it('INVARIANT: attribute_selector with configured test attribute NEVER returns user_visible_text drift', () => {
    const r = classifyLocatorDrift({
      failingLocator: parseLocatorExpression(`[data-test="checkout-btn"]`)!,
      ariaSnapshot:   [{
        role: 'button',
        name: 'Place Order',  // text "changed" but we have no prior to compare against
        testAttributes: { 'data-test': 'place-order-btn' },
      }],
    });
    assert.notEqual(r.kind, 'locator_drift_user_visible_text');
  });

  // Codex re-review P1: exact-match candidate lookup must filter by
  // CONFIGURED test-attribute keys. An unconfigured attribute that
  // happens to carry the same value must not establish a repair target.
  it('does NOT use unconfigured test-attribute values to establish exact-match repair target', () => {
    // Consumer config: only data-test counts. Snapshot has BOTH an
    // unconfigured data-testid matching the old locator value AND a
    // candidate carrying a different data-test value.
    const r = classifyLocatorDrift({
      failingLocator:     parseLocatorExpression(`[data-test="product-list"]`)!,
      ariaSnapshot: [
        {
          // An UNRELATED element. Its data-testid matches the locator's
          // value but data-testid is NOT in the configured testAttrs.
          // This element must not be selected as the repair target.
          role: 'banner',
          name: 'Footer banner',
          testAttributes: { 'data-testid': 'product-list' },
        },
        {
          // The intended candidate (overlapping name "Products") whose
          // data-test attribute has drifted.
          role: 'list',
          name: 'Products',
          testAttributes: { 'data-test': 'products-list' },
        },
      ],
      testAttributeNames: ['data-test'],
    });
    // The candidate must be the second element (drift in configured
    // data-test attribute), so we expect data_testid_only drift, NOT a
    // null result that would happen if the wrong element was selected.
    assert.equal(r.kind, 'locator_drift_data_testid_only');
    assert.equal(r.candidate?.name, 'Products');
  });

  // Symmetric case: the unconfigured attribute appears alone (no other
  // strong candidate). The classifier should NOT use it as a repair
  // target — it should return null.
  it('returns null when only unconfigured test-attribute carries the exact value', () => {
    const r = classifyLocatorDrift({
      failingLocator:     parseLocatorExpression(`[data-test="checkout-btn"]`)!,
      ariaSnapshot: [
        {
          // Unrelated element; its data-testid value matches what the
          // locator expects, but data-testid is unconfigured.
          role: 'navigation',
          name: 'Footer nav',
          testAttributes: { 'data-testid': 'checkout-btn' },
        },
      ],
      testAttributeNames: ['data-test'],
    });
    assert.equal(r.kind, null);
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

  it('hand-crafted: zero mismatches AND ≥85% per active sub-kind', () => {
    const { byKind, failures } = evalCases(HAND_CRAFTED_CASES);
    // Codex review hardening: log every mismatch AND fail on any of them.
    // The corpus is small enough that all hand-crafted cases should pass;
    // a single mismatch usually indicates either a real classifier
    // regression or a stale fixture that needs updating, neither of
    // which should hide behind a 15% slack.
    if (failures.length > 0) {
      console.log('hand-crafted failures:',
        failures.map(f => `\n  - ${f}`).join(''));
    }
    assert.equal(failures.length, 0,
      `${failures.length} hand-crafted mismatch(es); see log above`);
    for (const [kind, s] of Object.entries(byKind)) {
      if (s.total === 0) continue;
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
