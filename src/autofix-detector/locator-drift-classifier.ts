/**
 * ARIA-aware locator-drift classifier — the safety-critical Phase 1
 * deliverable. Given a failing locator and an ARIA snapshot captured at
 * the failure moment, decide which of the four locator-drift sub-kinds
 * applies.
 *
 * The autofix gating story rests on this distinction:
 *   - locator_drift_data_testid_only    → auto-eligible (test-infra change)
 *   - locator_drift_css_class_only      → hold (styling refactor risk)
 *   - locator_drift_user_visible_text   → hold/reject (regression risk)
 *   - locator_drift_dom_structure       → hold/reject (structural change)
 *
 * Implementation is purely structural — no LLM, no semantic reasoning.
 * Match the failing locator's properties against the ARIA snapshot,
 * classify the drift by the kind of attribute the locator referenced.
 *
 * Phase 0 reconciliation: the `testAttributeNames` option accepts the
 * consumer's configured test attribute (aisle-checker uses `data-test`;
 * the upstream default set covers the four common conventions).
 */

import {
  type AriaSnapshotElement,
  type LocatorDriftClassification,
  type ParsedLocator,
  DEFAULT_TEST_ATTRIBUTE_NAMES,
} from './types.js';

export interface ClassifierInput {
  failingLocator:      ParsedLocator;
  ariaSnapshot:        AriaSnapshotElement[];
  testAttributeNames?: readonly string[];
}

/**
 * Patterns that indicate a CSS selector relies on DOM structure rather
 * than stable identifiers. Shared between `locatorAttributeKind` and
 * `domStructureDrifted` so the two stay in sync.
 */
const STRUCTURAL_SELECTOR_PATTERN =
  /[>+~]|:nth-|:first-|:last-|:only-|:empty|:not\(|:checked/;

/**
 * Loose word-overlap heuristic for matching testid-style names. Tokenizes
 * both inputs on separators, matches if any token from one is a
 * substring of any token from the other (handles plural/singular and
 * suffixed variants).
 */
function tokensOverlap(a: string, b: string): boolean {
  const tokenize = (s: string) =>
    s.toLowerCase()
     .replace(/[_-]+/g, ' ')
     .split(/\s+/)
     .filter(t => t.length >= 3);
  const ta = tokenize(a);
  const tb = tokenize(b);
  return tb.some(t => ta.some(at => at.includes(t) || t.includes(at)));
}

function findCandidate(
  loc:       ParsedLocator,
  snapshot:  AriaSnapshotElement[],
  testAttrs: readonly string[],
): AriaSnapshotElement | null {
  if (snapshot.length === 0) return null;

  switch (loc.kind) {
    case 'getByTestId':
    case 'attribute_selector': {
      if (!loc.value) return null;
      const v = loc.value.toLowerCase();
      const byName = snapshot.find(
        e => e.name && tokensOverlap(e.name.toLowerCase(), v),
      );
      if (byName) return byName;
      const anyWithTestAttr = snapshot.find(
        e => e.testAttributes && Object.keys(e.testAttributes)
              .some(k => testAttrs.includes(k.toLowerCase())),
      );
      return anyWithTestAttr ?? null;
    }

    case 'getByRole': {
      if (!loc.value) return null;
      const [role, name] = loc.value.split(':');
      const exact = snapshot.find(
        e => e.role.toLowerCase() === role!.toLowerCase() &&
             (!name || e.name?.toLowerCase().includes(name.toLowerCase())),
      );
      if (exact) return exact;
      const roleOnly = snapshot.find(
        e => e.role.toLowerCase() === role!.toLowerCase(),
      );
      return roleOnly ?? null;
    }

    case 'getByText':
    case 'getByLabel':
    case 'getByPlaceholder': {
      if (!loc.value) return null;
      const v = loc.value.toLowerCase();
      const exact = snapshot.find(
        e => e.name?.toLowerCase().includes(v) || e.text?.toLowerCase().includes(v),
      );
      if (exact) return exact;
      // No exact text match — text drifted. Return a reasonable
      // interactive/textual candidate so downstream detects the drift.
      const interactiveOrTextual = snapshot.find(
        e => ['button', 'link', 'heading', 'textbox', 'searchbox',
              'status', 'text', 'alert'].includes(e.role.toLowerCase()),
      );
      return interactiveOrTextual ?? snapshot[0] ?? null;
    }

    case 'css_selector': {
      if (!loc.value) return null;
      const idMatch    = loc.value.match(/#([\w-]+)/);
      const classMatch = loc.value.match(/\.([\w-]+)/g);
      if (idMatch) {
        const id = idMatch[1]!.toLowerCase();
        const byId = snapshot.find(
          e => e.name?.toLowerCase().includes(id) ||
               e.text?.toLowerCase().includes(id),
        );
        if (byId) return byId;
      }
      if (classMatch && classMatch.length > 0) {
        const targetClasses = classMatch.map(c => c.slice(1).toLowerCase());
        const byClass = snapshot.find(
          e => e.classes?.some(c => targetClasses.includes(c.toLowerCase())),
        );
        if (byClass) return byClass;
      }
      return snapshot[0] ?? null;
    }

    default:
      return null;
  }
}

function locatorAttributeKind(
  loc:       ParsedLocator,
  testAttrs: readonly string[],
): 'test_attribute' | 'css_class' | 'user_visible_text' | 'dom_structure' | 'id_attribute' {
  if (loc.kind === 'getByTestId') return 'test_attribute';
  if (loc.kind === 'attribute_selector') {
    const attr = loc.testAttribute?.toLowerCase() ?? '';
    if (testAttrs.includes(attr)) return 'test_attribute';
    if (attr === 'id') return 'id_attribute';
    return 'css_class';
  }
  if (loc.kind === 'getByText' || loc.kind === 'getByLabel' ||
      loc.kind === 'getByPlaceholder') {
    return 'user_visible_text';
  }
  if (loc.kind === 'getByRole') return 'user_visible_text';
  if (loc.kind === 'css_selector' && loc.value) {
    if (/^#[\w-]+$/.test(loc.value)) return 'id_attribute';
    if (/^\.[\w-]+$/.test(loc.value)) return 'css_class';
    if (STRUCTURAL_SELECTOR_PATTERN.test(loc.value)) return 'dom_structure';
    // Deep descendant chains (3+ tokens) → structural reliance.
    const depthTokens = loc.value.trim().split(/\s+/).filter(t => t.length > 0);
    if (depthTokens.length >= 3) return 'dom_structure';
    return 'css_class';
  }
  return 'css_class';
}

function userVisibleTextDrifted(
  loc:       ParsedLocator,
  candidate: AriaSnapshotElement,
): boolean {
  if (!loc.value) return false;
  const expected = loc.value.toLowerCase();
  if (loc.kind === 'getByRole') {
    const [, name] = loc.value.split(':');
    if (!name) return false;
    return !(candidate.name?.toLowerCase().includes(name.toLowerCase()) ?? false);
  }
  if (loc.kind === 'getByText') {
    return !(
      candidate.text?.toLowerCase().includes(expected) ||
      candidate.name?.toLowerCase().includes(expected)
    );
  }
  if (loc.kind === 'getByLabel' || loc.kind === 'getByPlaceholder') {
    return !(candidate.name?.toLowerCase().includes(expected) ?? false);
  }
  return false;
}

function domStructureDrifted(
  loc:       ParsedLocator,
  candidate: AriaSnapshotElement,
): boolean {
  void candidate;
  if (loc.kind !== 'css_selector' || !loc.value) return false;
  if (STRUCTURAL_SELECTOR_PATTERN.test(loc.value)) return true;
  const depthTokens = loc.value.trim().split(/\s+/).filter(t => t.length > 0);
  return depthTokens.length >= 3;
}

export function classifyLocatorDrift(input: ClassifierInput): LocatorDriftClassification {
  const testAttrs = (input.testAttributeNames ?? DEFAULT_TEST_ATTRIBUTE_NAMES)
    .map(s => s.toLowerCase());

  if (input.ariaSnapshot.length === 0) {
    return {
      kind:       null,
      confidence: 0,
      reasoning:  'ARIA snapshot is empty; cannot classify drift kind',
    };
  }

  const candidate = findCandidate(input.failingLocator, input.ariaSnapshot, testAttrs);
  if (!candidate) {
    return {
      kind:       null,
      confidence: 0,
      reasoning:  'no candidate ARIA element matched the failing locator',
    };
  }

  const attrKind = locatorAttributeKind(input.failingLocator, testAttrs);

  // Priority 1: user-visible text drift (most dangerous; always wins).
  if (attrKind === 'user_visible_text' &&
      userVisibleTextDrifted(input.failingLocator, candidate)) {
    return {
      kind:       'locator_drift_user_visible_text',
      confidence: 0.85,
      candidate,
      reasoning:
        `locator targeted user-visible ${input.failingLocator.kind} ` +
        `value "${input.failingLocator.value}" but candidate has name ` +
        `"${candidate.name ?? '(none)'}"`,
    };
  }

  // Priority 2: DOM-structure drift for structural selectors.
  if (attrKind === 'dom_structure' &&
      domStructureDrifted(input.failingLocator, candidate)) {
    return {
      kind:       'locator_drift_dom_structure',
      confidence: 0.80,
      candidate,
      reasoning:
        `locator used structural combinator(s) in "${input.failingLocator.value}" ` +
        `but candidate's DOM position differs`,
    };
  }

  // Priority 3: test attribute drift — auto-eligible.
  if (attrKind === 'test_attribute') {
    const hasMatchingTestAttr = !!candidate.testAttributes &&
      Object.entries(candidate.testAttributes)
        .some(([k, v]) =>
          testAttrs.includes(k.toLowerCase()) &&
          v !== input.failingLocator.value,
        );
    if (hasMatchingTestAttr) {
      return {
        kind:       'locator_drift_data_testid_only',
        confidence: 0.90,
        candidate,
        reasoning:
          `failing locator referenced test attribute with value ` +
          `"${input.failingLocator.value}", but candidate has a ` +
          `different test attribute value`,
      };
    }
    return {
      kind:       'locator_drift_data_testid_only',
      confidence: 0.70,
      candidate,
      reasoning:
        `failing locator referenced test attribute ` +
        `"${input.failingLocator.value}" which no longer exists on the ` +
        `matched element`,
    };
  }

  // Priority 4: CSS class drift.
  if (attrKind === 'css_class' || attrKind === 'id_attribute') {
    return {
      kind:       'locator_drift_css_class_only',
      confidence: 0.75,
      candidate,
      reasoning:
        `locator referenced CSS class/id selector ` +
        `"${input.failingLocator.value}"; candidate is reachable via ` +
        `stable role/name`,
    };
  }

  return {
    kind:       null,
    confidence: 0,
    reasoning:  'no matching drift pattern',
  };
}
