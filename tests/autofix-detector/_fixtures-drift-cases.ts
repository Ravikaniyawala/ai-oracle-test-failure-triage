/**
 * Hand-crafted drift cases for the locator-drift classifier eval.
 *
 * Each case has:
 *   - locatorExpression: the literal selector/method the test used
 *   - ariaSnapshot:      what the ARIA snapshot looks like at failure
 *   - expectedKind:      the sub-kind the classifier should return
 *   - rationale:         human-readable explanation
 *
 * We aim for 20 cases per sub-kind (80 total hand-crafted) PLUS a synthetic
 * generator that produces 50 more per kind by parameterizing realistic
 * aisle-checker-style shapes (data-test, getByRole, etc.).
 */

import type { AriaSnapshotElement, LocatorDriftKind } from '../../src/autofix-detector/types.js';

export interface DriftCase {
  id:                 string;
  locatorExpression:  string;     // verbatim from a test, used by parseLocatorExpression
  ariaSnapshot:       AriaSnapshotElement[];
  expectedKind:       LocatorDriftKind;
  rationale:          string;
  testAttributeNames?: string[]; // override for repos using non-default names
}

// ── locator_drift_data_testid_only (20 cases) ────────────────────────────

const DATA_TESTID_CASES: DriftCase[] = [
  {
    id: 'testid-01-aisle-checker-product-list',
    locatorExpression: `getByTestId('product-list')`,
    ariaSnapshot: [
      { role: 'list', name: 'Products', testAttributes: { 'data-test': 'products-list' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-test value changed from product-list to products-list; role/name identical',
  },
  {
    id: 'testid-02-checkout-btn-renamed-attribute',
    locatorExpression: `getByTestId('checkout-btn')`,
    ariaSnapshot: [
      { role: 'button', name: 'Checkout', testAttributes: { 'data-test': 'checkout-button' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'button still says Checkout, but data-test value drifted',
  },
  {
    id: 'testid-03-attribute-selector-data-test',
    locatorExpression: `[data-test="store-card"]`,
    ariaSnapshot: [
      { role: 'article', name: 'North Store', testAttributes: { 'data-test': 'store-tile' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'attribute selector with data-test attribute drifted',
  },
  {
    id: 'testid-04-data-testid-default-attribute',
    locatorExpression: `[data-testid="nav-products"]`,
    ariaSnapshot: [
      { role: 'link', name: 'Products', testAttributes: { 'data-testid': 'nav-items-products' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-testid attribute value drifted; name unchanged',
  },
  {
    id: 'testid-05-availability-badge-data-status',
    locatorExpression: `getByTestId('availability-badge')`,
    ariaSnapshot: [
      { role: 'status', name: 'In Stock', testAttributes: { 'data-test': 'stock-badge' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'badge role+name preserved, data-test changed',
  },
  {
    id: 'testid-06-data-qa-attribute',
    locatorExpression: `[data-qa="sign-in"]`,
    ariaSnapshot: [
      { role: 'button', name: 'Sign in', testAttributes: { 'data-qa': 'login-btn' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-qa attribute drifted',
  },
  {
    id: 'testid-07-data-cy-attribute',
    locatorExpression: `[data-cy="submit"]`,
    ariaSnapshot: [
      { role: 'button', name: 'Submit', testAttributes: { 'data-cy': 'submit-button' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-cy attribute drifted',
  },
  {
    id: 'testid-08-data-test-prefix-added',
    locatorExpression: `getByTestId('product-aisle')`,
    ariaSnapshot: [
      // Drifted: data-test value gained a prefix during refactor.
      // (Originally this case was "data-test removed entirely" but per the
      // post-Codex inference-safety rules, a candidate with no test
      // attributes cannot confidently classify as data_testid drift —
      // we'd be inferring prior state from current ARIA alone. That
      // scenario now correctly returns null and is exercised in the
      // safety-regressions test suite.)
      { role: 'text', name: 'Product Aisle', testAttributes: { 'data-test': 'detail-product-aisle' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-test value prefixed during refactor; name still overlaps',
  },
  {
    id: 'testid-09-similar-token-overlap',
    locatorExpression: `getByTestId('store-product-card')`,
    ariaSnapshot: [
      { role: 'article', name: 'Store Product', testAttributes: { 'data-test': 'store-product-tile' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'token overlap (store, product) confirms candidate; testid drift',
  },
  {
    id: 'testid-10-detail-page',
    locatorExpression: `[data-test="product-detail-page"]`,
    ariaSnapshot: [
      { role: 'main', name: 'Product Detail', testAttributes: { 'data-test': 'detail-product-page' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'detail page test attribute drifted; main role preserved',
  },
  {
    id: 'testid-11-attribute-removed-by-refactor',
    locatorExpression: `getByTestId('back-link')`,
    ariaSnapshot: [
      { role: 'link', name: 'Back', testAttributes: { 'data-test': 'back-to-products-link' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-test value expanded by refactor; link still semantically Back',
  },
  {
    id: 'testid-12-product-card-renamed',
    locatorExpression: `[data-test="product-card"]`,
    ariaSnapshot: [
      { role: 'article', name: 'Product Card', testAttributes: { 'data-test': 'card-product' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'attribute order rearranged; element identity intact',
  },
  {
    id: 'testid-13-uppercase-vs-lowercase-attr-value',
    locatorExpression: `getByTestId('Store-Card')`,
    ariaSnapshot: [
      { role: 'article', name: 'Store Card', testAttributes: { 'data-test': 'store-card' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'casing convention changed for data-test',
  },
  {
    id: 'testid-14-detail-product-name-renamed',
    locatorExpression: `getByTestId('detail-product-name')`,
    ariaSnapshot: [
      { role: 'heading', name: 'Full Cream Milk 2L', testAttributes: { 'data-test': 'product-name-detail' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-test value reordered tokens; heading text unchanged',
  },
  {
    id: 'testid-15-namespaced-testid',
    locatorExpression: `[data-test="checkout.button"]`,
    ariaSnapshot: [
      { role: 'button', name: 'Checkout', testAttributes: { 'data-test': 'checkout__button' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'separator convention changed (. → __)',
  },
  {
    id: 'testid-16-singular-vs-plural',
    locatorExpression: `getByTestId('product')`,
    ariaSnapshot: [
      { role: 'article', name: 'Products', testAttributes: { 'data-test': 'products' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'singular vs plural in data-test; role preserved',
  },
  {
    id: 'testid-17-cypress-style-attribute',
    locatorExpression: `[data-cy="nav-stores"]`,
    ariaSnapshot: [
      { role: 'link', name: 'Stores', testAttributes: { 'data-cy': 'nav-stores-link' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-cy attribute drifted',
  },
  {
    id: 'testid-18-multiple-test-attributes-on-element',
    locatorExpression: `[data-test="add-to-cart"]`,
    ariaSnapshot: [
      { role: 'button', name: 'Add to cart', testAttributes: { 'data-test': 'add-cart-btn', 'data-qa': 'addToCart' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-test drifted; data-qa also present',
  },
  {
    id: 'testid-19-old-format-vs-new-format',
    locatorExpression: `getByTestId('header_nav')`,
    ariaSnapshot: [
      { role: 'navigation', name: 'Main', testAttributes: { 'data-test': 'header-nav' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'naming convention migrated _ → -',
  },
  {
    id: 'testid-20-stores-page-attribute',
    locatorExpression: `getByTestId('stores-page')`,
    ariaSnapshot: [
      { role: 'main', name: 'Stores', testAttributes: { 'data-test': 'stores' } },
    ],
    expectedKind: 'locator_drift_data_testid_only',
    rationale: 'data-test suffix simplified',
  },
];

// ── locator_drift_css_class_only (20 cases) ──────────────────────────────

const CSS_CLASS_CASES: DriftCase[] = [
  {
    id: 'css-01-product-card-class',
    locatorExpression: `locator('.product-card')`,
    ariaSnapshot: [
      { role: 'article', name: 'Product', classes: ['product-tile'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'CSS class renamed during styling refactor',
  },
  {
    id: 'css-02-button-primary',
    locatorExpression: `locator('.btn-primary')`,
    ariaSnapshot: [
      { role: 'button', name: 'Submit', classes: ['button', 'primary'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'compound class split into two utility classes',
  },
  {
    id: 'css-03-id-selector',
    locatorExpression: `locator('#main-nav')`,
    ariaSnapshot: [
      { role: 'navigation', name: 'Main' },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'id selector drift treated as css_class for routing purposes',
  },
  {
    id: 'css-04-class-removed',
    locatorExpression: `locator('.checkout-summary')`,
    ariaSnapshot: [
      { role: 'region', name: 'Checkout Summary', classes: ['summary'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'specific class removed; region still semantically clear',
  },
  {
    id: 'css-05-bem-block-element',
    locatorExpression: `locator('.card__header')`,
    ariaSnapshot: [
      { role: 'heading', name: 'Card title', classes: ['card-header'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'BEM → flat class naming migration',
  },
  {
    id: 'css-06-tailwind-utility-shift',
    locatorExpression: `locator('.bg-blue-500')`,
    ariaSnapshot: [
      { role: 'button', name: 'Action', classes: ['bg-blue-600'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'tailwind utility class shade changed',
  },
  {
    id: 'css-07-scoped-class-replaced',
    locatorExpression: `locator('.products-page-header')`,
    ariaSnapshot: [
      { role: 'banner', name: 'Products', classes: ['page-header'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'scoped class replaced by generic one',
  },
  {
    id: 'css-08-multiple-class-target',
    locatorExpression: `locator('.error-message')`,
    ariaSnapshot: [
      { role: 'alert', name: 'Error', classes: ['alert', 'alert--error'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'error class renamed via BEM-style modifier',
  },
  {
    id: 'css-09-hyphen-to-underscore',
    locatorExpression: `locator('.product-aisle')`,
    ariaSnapshot: [
      { role: 'text', name: 'Aisle B1', classes: ['product_aisle'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'hyphen → underscore convention',
  },
  {
    id: 'css-10-uppercase-class',
    locatorExpression: `locator('.NavBar')`,
    ariaSnapshot: [
      { role: 'navigation', name: 'Site', classes: ['navbar'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'PascalCase → lowercase class',
  },
  {
    id: 'css-11-css-modules-hash',
    locatorExpression: `locator('.product-card')`,
    ariaSnapshot: [
      { role: 'article', name: 'Item', classes: ['ProductCard_abc123'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'CSS modules added hash suffix',
  },
  {
    id: 'css-12-id-renamed',
    locatorExpression: `locator('#checkout-btn')`,
    ariaSnapshot: [
      { role: 'button', name: 'Checkout' },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'id selector renamed',
  },
  {
    id: 'css-13-nested-class',
    locatorExpression: `locator('.parent .child')`,
    ariaSnapshot: [
      { role: 'group', name: 'Child', classes: ['child-element'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'nested class targeting; refactor renamed parent or child',
  },
  {
    id: 'css-14-utility-vs-semantic',
    locatorExpression: `locator('.text-bold')`,
    ariaSnapshot: [
      { role: 'text', name: 'Important', classes: ['font-bold'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'utility prefix renamed',
  },
  {
    id: 'css-15-vendor-prefix-removed',
    locatorExpression: `locator('.ui-button')`,
    ariaSnapshot: [
      { role: 'button', name: 'Click me', classes: ['button'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'vendor library prefix removed after migration',
  },
  {
    id: 'css-16-class-prefixed',
    locatorExpression: `locator('.modal')`,
    ariaSnapshot: [
      { role: 'dialog', name: 'Confirm', classes: ['app-modal'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'app-wide prefix added to scope class',
  },
  {
    id: 'css-17-typo-fixed',
    locatorExpression: `locator('.shoping-cart')`,
    ariaSnapshot: [
      { role: 'region', name: 'Shopping cart', classes: ['shopping-cart'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'typo in class corrected by product team',
  },
  {
    id: 'css-18-class-cleanup',
    locatorExpression: `locator('.tmp-header')`,
    ariaSnapshot: [
      { role: 'banner', name: 'Header', classes: ['header'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'temporary class removed after refactor',
  },
  {
    id: 'css-19-utility-renamed',
    locatorExpression: `locator('.flex-row')`,
    ariaSnapshot: [
      { role: 'group', name: 'Layout', classes: ['row', 'flex'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'flex-row split into two utilities',
  },
  {
    id: 'css-20-suffix-version',
    locatorExpression: `locator('.cta-v1')`,
    ariaSnapshot: [
      { role: 'button', name: 'Call to action', classes: ['cta-v2'] },
    ],
    expectedKind: 'locator_drift_css_class_only',
    rationale: 'versioned class incremented',
  },
];

// ── locator_drift_user_visible_text (20 cases) ───────────────────────────

const USER_VISIBLE_TEXT_CASES: DriftCase[] = [
  {
    id: 'text-01-checkout-renamed-to-place-order',
    locatorExpression: `getByText('Checkout')`,
    ariaSnapshot: [
      { role: 'button', name: 'Place Order', text: 'Place Order' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'CTA label changed from Checkout to Place Order — could be regression or intentional',
  },
  {
    id: 'text-02-getbyrole-name-changed',
    locatorExpression: `getByRole('button', { name: 'Sign in' })`,
    ariaSnapshot: [
      { role: 'button', name: 'Log in' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'role correct; visible name changed Sign in → Log in',
  },
  {
    id: 'text-03-in-stock-vs-available',
    locatorExpression: `getByText('In Stock')`,
    ariaSnapshot: [
      { role: 'status', name: 'Available', text: 'Available' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'badge text changed In Stock → Available',
  },
  {
    id: 'text-04-back-link-text',
    locatorExpression: `getByText('Back')`,
    ariaSnapshot: [
      { role: 'link', name: 'Return to products', text: 'Return to products' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'link text expanded; could be UX improvement or regression',
  },
  {
    id: 'text-05-label-rewording',
    locatorExpression: `getByLabel('Email address')`,
    ariaSnapshot: [
      { role: 'textbox', name: 'Email' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'label shortened',
  },
  {
    id: 'text-06-placeholder-text-changed',
    locatorExpression: `getByPlaceholder('Search products')`,
    ariaSnapshot: [
      { role: 'searchbox', name: 'Find items' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'placeholder text rewritten',
  },
  {
    id: 'text-07-getbyrole-with-similar-name',
    locatorExpression: `getByRole('button', { name: 'Add to cart' })`,
    ariaSnapshot: [
      { role: 'button', name: 'Add to bag' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'common ecommerce rename cart → bag',
  },
  {
    id: 'text-08-heading-text',
    locatorExpression: `getByRole('heading', { name: 'Welcome' })`,
    ariaSnapshot: [
      { role: 'heading', name: 'Welcome to AisleChecker' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'heading expanded with brand name',
  },
  {
    id: 'text-09-cta-localized',
    locatorExpression: `getByText('Submit')`,
    ariaSnapshot: [
      { role: 'button', name: 'Soumettre', text: 'Soumettre' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'localization change — definitely needs human review',
  },
  {
    id: 'text-10-stock-status-label',
    locatorExpression: `getByText('Out of Stock')`,
    ariaSnapshot: [
      { role: 'status', name: 'Unavailable', text: 'Unavailable' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'status terminology changed',
  },
  {
    id: 'text-11-aisle-display',
    locatorExpression: `getByText('Aisle A3')`,
    ariaSnapshot: [
      { role: 'text', name: 'Located in A3', text: 'Located in A3' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'display format for aisle changed',
  },
  {
    id: 'text-12-store-name-prefix',
    locatorExpression: `getByText('North Store')`,
    ariaSnapshot: [
      { role: 'heading', name: 'AisleChecker North', text: 'AisleChecker North' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'store branding changed',
  },
  {
    id: 'text-13-price-display-format',
    locatorExpression: `getByText('$5.99')`,
    ariaSnapshot: [
      { role: 'text', name: '5.99 USD', text: '5.99 USD' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'price format changed — risky autofix (could be currency-handling regression)',
  },
  {
    id: 'text-14-nav-label-shortened',
    locatorExpression: `getByText('Our Products')`,
    ariaSnapshot: [
      { role: 'link', name: 'Products' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'navigation label shortened',
  },
  {
    id: 'text-15-button-name-with-icon',
    locatorExpression: `getByRole('button', { name: 'Save' })`,
    ariaSnapshot: [
      { role: 'button', name: 'Save changes' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'button name expanded for clarity',
  },
  {
    id: 'text-16-empty-state-text',
    locatorExpression: `getByText('No products available')`,
    ariaSnapshot: [
      { role: 'text', name: 'No items match your filters', text: 'No items match your filters' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'empty-state copy rewritten',
  },
  {
    id: 'text-17-confirmation-message',
    locatorExpression: `getByText('Order confirmed')`,
    ariaSnapshot: [
      { role: 'alert', name: 'Thank you for your order!', text: 'Thank you for your order!' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'confirmation copy completely rewritten',
  },
  {
    id: 'text-18-low-stock-warning',
    locatorExpression: `getByText('Low Stock')`,
    ariaSnapshot: [
      { role: 'status', name: 'Only a few left', text: 'Only a few left' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'warning text changed',
  },
  {
    id: 'text-19-link-text-action',
    locatorExpression: `getByText('View details')`,
    ariaSnapshot: [
      { role: 'link', name: 'See more' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'action link text changed',
  },
  {
    id: 'text-20-account-vs-profile',
    locatorExpression: `getByRole('link', { name: 'Account' })`,
    ariaSnapshot: [
      { role: 'link', name: 'Profile' },
    ],
    expectedKind: 'locator_drift_user_visible_text',
    rationale: 'navigation item renamed Account → Profile',
  },
];

// ── locator_drift_dom_structure (20 cases) ───────────────────────────────

const DOM_STRUCTURE_CASES: DriftCase[] = [
  {
    id: 'dom-01-nth-child-shift',
    locatorExpression: `locator('ul > li:nth-child(2)')`,
    ariaSnapshot: [
      { role: 'listitem', name: 'Sourdough Bread' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'nth-child position shifted after refactor',
  },
  {
    id: 'dom-02-direct-child-combinator',
    locatorExpression: `locator('.parent > .child')`,
    ariaSnapshot: [
      { role: 'group', name: 'Child' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'direct-child combinator broken by wrapper element',
  },
  {
    id: 'dom-03-adjacent-sibling',
    locatorExpression: `locator('.label + .value')`,
    ariaSnapshot: [
      { role: 'text', name: 'Value text' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'sibling order changed',
  },
  {
    id: 'dom-04-first-child',
    locatorExpression: `locator('.list :first-child')`,
    ariaSnapshot: [
      { role: 'listitem', name: 'Now-Second Item' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'first-child target shifted',
  },
  {
    id: 'dom-05-last-child',
    locatorExpression: `locator('ul li:last-child')`,
    ariaSnapshot: [
      { role: 'listitem', name: 'Item' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'last-child changed when new item appended',
  },
  {
    id: 'dom-06-general-sibling',
    locatorExpression: `locator('h2 ~ p')`,
    ariaSnapshot: [
      { role: 'paragraph', name: 'Paragraph' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'general sibling broken by structural change',
  },
  {
    id: 'dom-07-not-selector',
    locatorExpression: `locator('.card:not(.disabled)')`,
    ariaSnapshot: [
      { role: 'article', name: 'Card' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'negation selector relying on sibling structure',
  },
  {
    id: 'dom-08-deep-descendant',
    locatorExpression: `locator('.app .content .item .price')`,
    ariaSnapshot: [
      { role: 'text', name: '$5.99' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'deep descendant chain broken by wrapper insertion',
  },
  {
    id: 'dom-09-nth-of-type',
    locatorExpression: `locator('.row:nth-of-type(3)')`,
    ariaSnapshot: [
      { role: 'row', name: 'Row 3' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'nth-of-type ordinal shifted',
  },
  {
    id: 'dom-10-empty-selector',
    locatorExpression: `locator('.list :empty')`,
    ariaSnapshot: [
      { role: 'group', name: 'Group' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'empty-state structural assumption',
  },
  {
    id: 'dom-11-multiple-combinators',
    locatorExpression: `locator('.a > .b + .c')`,
    ariaSnapshot: [
      { role: 'group', name: 'C' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'chained combinators broken by DOM refactor',
  },
  {
    id: 'dom-12-only-child',
    locatorExpression: `locator('.wrapper :only-child')`,
    ariaSnapshot: [
      { role: 'group', name: 'Item' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'only-child no longer alone',
  },
  {
    id: 'dom-13-position-via-nth-last',
    locatorExpression: `locator('li:nth-last-child(2)')`,
    ariaSnapshot: [
      { role: 'listitem', name: 'Item' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'nth-last-child position shift',
  },
  {
    id: 'dom-14-direct-children-only',
    locatorExpression: `locator('.parent > *')`,
    ariaSnapshot: [
      { role: 'group', name: 'Children' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'universal direct child requires no wrapper added',
  },
  {
    id: 'dom-15-table-row-position',
    locatorExpression: `locator('tr:nth-child(odd)')`,
    ariaSnapshot: [
      { role: 'row', name: 'Row' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'odd-row striping broken by sort order change',
  },
  {
    id: 'dom-16-input-position-in-form',
    locatorExpression: `locator('form input:nth-of-type(2)')`,
    ariaSnapshot: [
      { role: 'textbox', name: 'New field' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'form input order changed when field added',
  },
  {
    id: 'dom-17-card-nth',
    locatorExpression: `locator('.product-card:nth-child(3)')`,
    ariaSnapshot: [
      { role: 'article', name: 'Product' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'product card ordering changed (e.g. sorting changed)',
  },
  {
    id: 'dom-18-after-first-heading',
    locatorExpression: `locator('h1 + section')`,
    ariaSnapshot: [
      { role: 'region', name: 'Section' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'adjacent sibling broken by intervening element',
  },
  {
    id: 'dom-19-table-cell-position',
    locatorExpression: `locator('td:nth-of-type(4)')`,
    ariaSnapshot: [
      { role: 'cell', name: 'Cell' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'column order changed',
  },
  {
    id: 'dom-20-nested-positional',
    locatorExpression: `locator('.list > .item:nth-child(1) > .price')`,
    ariaSnapshot: [
      { role: 'text', name: '$3.49' },
    ],
    expectedKind: 'locator_drift_dom_structure',
    rationale: 'nested positional selector — multiple structural assumptions',
  },
];

export const HAND_CRAFTED_CASES: DriftCase[] = [
  ...DATA_TESTID_CASES,
  ...CSS_CLASS_CASES,
  ...USER_VISIBLE_TEXT_CASES,
  ...DOM_STRUCTURE_CASES,
];

// ── Synthetic generator (50 per kind) ────────────────────────────────────

const REALISTIC_TESTID_NAMES = [
  'product-list', 'product-card', 'product-name', 'product-price', 'product-aisle',
  'availability-badge', 'store-list', 'store-card', 'nav-products', 'nav-stores',
  'back-link', 'detail-product-name', 'detail-product-price', 'detail-product-aisle',
  'checkout-btn', 'sign-in', 'sign-out', 'add-to-cart', 'remove-from-cart',
  'search-input', 'filter-toggle', 'sort-dropdown', 'pagination-next', 'pagination-prev',
  'main-content', 'sidebar', 'footer-links', 'header-logo', 'banner-message',
];

const REALISTIC_BUTTON_TEXTS = [
  'Submit', 'Cancel', 'Save', 'Delete', 'Confirm', 'Apply', 'Reset', 'Continue',
  'Back', 'Next', 'Sign in', 'Log out', 'Create account', 'Forgot password',
  'Search', 'Filter', 'Sort', 'View details', 'Add to cart', 'Buy now',
];

const REALISTIC_CSS_CLASSES = [
  'btn-primary', 'card', 'modal', 'navbar', 'sidebar', 'footer', 'header',
  'product-tile', 'item-row', 'list-container', 'wrapper', 'overlay',
  'badge', 'icon', 'tooltip', 'alert', 'banner', 'panel', 'tab', 'tabs',
];

const STRUCTURAL_SELECTORS = [
  '.list > .item:nth-child(1)',
  '.parent > .child',
  '.row + .row',
  'ul li:first-child',
  'ul li:last-child',
  '.card:nth-of-type(2)',
  '.section ~ .footer',
  '.grid > .cell:nth-child(3)',
  'table tr:nth-child(odd)',
  '.form input:not([type=hidden])',
];

function generateSyntheticCases(): DriftCase[] {
  const cases: DriftCase[] = [];

  // 50 data-testid drift cases
  for (let i = 0; i < 50; i++) {
    const original = REALISTIC_TESTID_NAMES[i % REALISTIC_TESTID_NAMES.length]!;
    const drifted  = `${original}-v${(i % 3) + 2}`;
    cases.push({
      id: `synth-testid-${i.toString().padStart(2, '0')}`,
      locatorExpression: `getByTestId('${original}')`,
      ariaSnapshot: [
        { role: 'generic', name: original, testAttributes: { 'data-test': drifted } },
      ],
      expectedKind: 'locator_drift_data_testid_only',
      rationale: `synthetic data-test rename ${original} → ${drifted}`,
    });
  }

  // 50 CSS-class drift cases
  for (let i = 0; i < 50; i++) {
    const original = REALISTIC_CSS_CLASSES[i % REALISTIC_CSS_CLASSES.length]!;
    const drifted  = `${original}--v2`;
    cases.push({
      id: `synth-css-${i.toString().padStart(2, '0')}`,
      locatorExpression: `locator('.${original}')`,
      ariaSnapshot: [
        { role: 'generic', name: original, classes: [drifted] },
      ],
      expectedKind: 'locator_drift_css_class_only',
      rationale: `synthetic CSS class rename .${original} → .${drifted}`,
    });
  }

  // 50 user-visible-text drift cases — pair each original with a TRULY
  // DIFFERENT replacement so the drift is real (Playwright's substring
  // matching would still resolve `Submit → Submit now`, which means the
  // earlier `${original} now` suffix-only generator produced cases that
  // wouldn't actually fail in production).
  const TEXT_RENAMES: Array<[string, string]> = [
    ['Submit',          'Send'],
    ['Cancel',          'Dismiss'],
    ['Save',            'Apply'],
    ['Delete',          'Remove'],
    ['Confirm',         'Proceed'],
    ['Apply',           'OK'],
    ['Reset',           'Clear'],
    ['Continue',        'Next step'],
    ['Back',            'Return'],
    ['Next',            'Forward'],
    ['Sign in',         'Log in'],
    ['Log out',         'Sign out'],
    ['Create account',  'Register'],
    ['Forgot password', 'Reset password'],
    ['Search',          'Find'],
    ['Filter',          'Refine'],
    ['Sort',            'Order'],
    ['View details',    'See more'],
    ['Add to cart',     'Add to bag'],
    ['Buy now',         'Purchase'],
  ];
  for (let i = 0; i < 50; i++) {
    const [original, drifted] = TEXT_RENAMES[i % TEXT_RENAMES.length]!;
    cases.push({
      id: `synth-text-${i.toString().padStart(2, '0')}`,
      locatorExpression: `getByRole('button', { name: '${original}' })`,
      ariaSnapshot: [
        { role: 'button', name: drifted },
      ],
      expectedKind: 'locator_drift_user_visible_text',
      rationale: `synthetic button label rename ${original} → ${drifted}`,
    });
  }

  // 50 DOM-structure drift cases
  for (let i = 0; i < 50; i++) {
    const sel = STRUCTURAL_SELECTORS[i % STRUCTURAL_SELECTORS.length]!;
    cases.push({
      id: `synth-dom-${i.toString().padStart(2, '0')}`,
      locatorExpression: `locator('${sel}')`,
      ariaSnapshot: [
        { role: 'generic', name: 'Shifted element' /* no pathSignature */ },
      ],
      expectedKind: 'locator_drift_dom_structure',
      rationale: `synthetic structural selector ${sel}`,
    });
  }

  return cases;
}

export const SYNTHETIC_CASES: DriftCase[] = generateSyntheticCases();
export const ALL_DRIFT_CASES: DriftCase[] = [...HAND_CRAFTED_CASES, ...SYNTHETIC_CASES];
