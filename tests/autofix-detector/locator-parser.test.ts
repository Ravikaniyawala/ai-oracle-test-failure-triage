import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFailingLocator,
  parseLocatorExpression,
} from '../../src/autofix-detector/locator-parser.js';

describe('parseFailingLocator', () => {
  it('returns null for empty/null/undefined input', () => {
    assert.equal(parseFailingLocator(''), null);
    // @ts-expect-error testing null safety
    assert.equal(parseFailingLocator(null), null);
    // @ts-expect-error
    assert.equal(parseFailingLocator(undefined), null);
  });

  it('extracts getByTestId value with single quotes', () => {
    const r = parseFailingLocator("waiting for getByTestId('product-list')");
    assert.ok(r);
    assert.equal(r.kind, 'getByTestId');
    assert.equal(r.value, 'product-list');
    assert.equal(r.testAttribute, 'data-testid');
  });

  it('extracts getByTestId value with double quotes', () => {
    const r = parseFailingLocator('waiting for getByTestId("nav-products")');
    assert.ok(r);
    assert.equal(r.value, 'nav-products');
  });

  it('extracts getByRole with name option', () => {
    const r = parseFailingLocator("getByRole('button', { name: 'Checkout' })");
    assert.ok(r);
    assert.equal(r.kind, 'getByRole');
    assert.equal(r.value, 'button:Checkout');
  });

  it('extracts getByRole without name option', () => {
    const r = parseFailingLocator("waiting for getByRole('heading')");
    assert.ok(r);
    assert.equal(r.kind, 'getByRole');
    assert.equal(r.value, 'heading');
  });

  it('extracts attribute selector with data-test', () => {
    const r = parseFailingLocator(`locator('[data-test="store-card"]')`);
    assert.ok(r);
    assert.equal(r.kind, 'attribute_selector');
    assert.equal(r.testAttribute, 'data-test');
    assert.equal(r.value, 'store-card');
  });

  it('handles attribute selector with spaces and no quotes', () => {
    const r = parseFailingLocator(`locator('[ data-test = "store-card" ]')`);
    assert.ok(r);
    assert.equal(r.kind, 'attribute_selector');
    assert.equal(r.value, 'store-card');
  });

  it('returns null for pure assertion failure', () => {
    assert.equal(parseFailingLocator('Error: expected true to be false'), null);
  });

  it('parses CSS id selector via locator()', () => {
    const r = parseFailingLocator("waiting for locator('#submit-btn')");
    assert.ok(r);
    assert.equal(r.kind, 'css_selector');
    assert.equal(r.cssSelector, '#submit-btn');
  });

  it('parses a nested CSS selector', () => {
    const r = parseFailingLocator("waiting for locator('.nav .item.active')");
    assert.ok(r);
    assert.equal(r.kind, 'css_selector');
    assert.equal(r.value, '.nav .item.active');
  });

  it('parses tag-attribute selectors', () => {
    const r = parseFailingLocator(`waiting for locator('input[type=password]')`);
    assert.ok(r);
    assert.equal(r.kind, 'css_selector');
    assert.equal(r.value, 'input[type=password]');
  });

  it('parses backtick-quoted getByTestId', () => {
    const r = parseFailingLocator('waiting for getByTestId(`stores-page`)');
    assert.ok(r);
    assert.equal(r.value, 'stores-page');
  });

  it('handles getByText', () => {
    const r = parseFailingLocator("getByText('Sign in')");
    assert.ok(r);
    assert.equal(r.kind, 'getByText');
    assert.equal(r.value, 'Sign in');
  });

  it('handles getByLabel', () => {
    const r = parseFailingLocator("getByLabel('Email address')");
    assert.ok(r);
    assert.equal(r.kind, 'getByLabel');
    assert.equal(r.value, 'Email address');
  });

  it('handles getByPlaceholder', () => {
    const r = parseFailingLocator("getByPlaceholder('Search products')");
    assert.ok(r);
    assert.equal(r.kind, 'getByPlaceholder');
    assert.equal(r.value, 'Search products');
  });
});

describe('parseLocatorExpression', () => {
  it('treats a bare attribute selector as parseable', () => {
    const r = parseLocatorExpression(`[data-test="product-list"]`);
    assert.ok(r);
    assert.equal(r.kind, 'attribute_selector');
    assert.equal(r.value, 'product-list');
  });

  it('handles getByTestId() expression directly (not as nested locator)', () => {
    const r = parseLocatorExpression(`getByTestId('checkout-btn')`);
    assert.ok(r);
    assert.equal(r.kind, 'getByTestId');
    assert.equal(r.value, 'checkout-btn');
  });

  it('falls back to wrapping bare CSS selectors', () => {
    const r = parseLocatorExpression(`.product-card`);
    assert.ok(r);
    assert.equal(r.kind, 'css_selector');
    assert.equal(r.value, '.product-card');
  });

  it('returns null for empty/whitespace input', () => {
    assert.equal(parseLocatorExpression(''), null);
    assert.equal(parseLocatorExpression('   '), null);
  });
});
