import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateTopology,
  topologyAllowsAuto,
} from '../../src/autofix-detector/topology-validator.js';

// Simple glob matcher for tests — production code injects picomatch.
// Transform order: extract glob tokens BEFORE escaping regex specials,
// then re-substitute so the final pattern compiles correctly.
function simpleMatch(file: string, pattern: string): boolean {
  const transformed = pattern
    .replace(/\*\*/g, '__DSTAR__')
    .replace(/\*/g,   '__STAR__')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/__DSTAR__/g, '.*')
    .replace(/__STAR__/g,  '[^/]*');
  return new RegExp(`^${transformed}$`).test(file);
}

let tmpRoot: string;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'phase1-topology-'));
  mkdirSync(join(tmpRoot, 'apps/aisle-ui/src'),            { recursive: true });
  mkdirSync(join(tmpRoot, 'apps/aisle-api/src/main/java'), { recursive: true });
  mkdirSync(join(tmpRoot, 'tests/e2e/src/pages'),          { recursive: true });
  mkdirSync(join(tmpRoot, 'tests/e2e/tests/products'),     { recursive: true });

  writeFileSync(join(tmpRoot, 'apps/aisle-ui/src/App.tsx'),                'export default function App() {}');
  writeFileSync(join(tmpRoot, 'apps/aisle-api/src/main/java/Foo.java'),    'class Foo {}');
  writeFileSync(join(tmpRoot, 'tests/e2e/src/pages/ProductsPage.ts'),      'export class ProductsPage {}');
  writeFileSync(join(tmpRoot, 'tests/e2e/tests/products/products.spec.ts'), 'test("x", () => {})');
});

after(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe('validateTopology', () => {
  it('returns full for monorepo_e2e with historical PR overlap', () => {
    const r = validateTopology({
      repoRoot:              tmpRoot,
      declaredTopology:      'monorepo_e2e',
      productSourcePatterns: { include: ['apps/*/src/**'], exclude: [] },
      allowedEditPaths:      ['tests/**'],
      historicalPrFilePaths: ['apps/aisle-ui/src/App.tsx'],
      matchPattern:          simpleMatch,
    });
    assert.equal(r.state, 'full');
    assert.equal(r.appChangeVisibilityProven, true);
    assert.ok(topologyAllowsAuto(r));
  });

  it('returns partial when no historical PR context yet', () => {
    const r = validateTopology({
      repoRoot:              tmpRoot,
      declaredTopology:      'monorepo_e2e',
      productSourcePatterns: { include: ['apps/*/src/**'], exclude: [] },
      allowedEditPaths:      ['tests/**'],
      historicalPrFilePaths: [],
      matchPattern:          simpleMatch,
    });
    assert.equal(r.state, 'partial');
    assert.equal(topologyAllowsAuto(r), false);
    assert.ok(r.validationWarnings.some(w => /unproven/.test(w)));
  });

  it('returns failed when PRODUCT_SOURCE_PATTERNS resolves to 0', () => {
    const r = validateTopology({
      repoRoot:              tmpRoot,
      declaredTopology:      'monorepo_e2e',
      productSourcePatterns: { include: ['nonexistent/**'], exclude: [] },
      allowedEditPaths:      ['tests/**'],
      matchPattern:          simpleMatch,
    });
    assert.equal(r.state, 'failed');
    assert.ok(r.validationFailures.some(f => /PRODUCT_SOURCE_PATTERNS resolved to 0/.test(f)));
    assert.equal(topologyAllowsAuto(r), false);
  });

  it('returns failed when allowedEditPaths resolves to 0', () => {
    const r = validateTopology({
      repoRoot:              tmpRoot,
      declaredTopology:      'monorepo_e2e',
      productSourcePatterns: { include: ['apps/*/src/**'], exclude: [] },
      allowedEditPaths:      ['nonexistent/**'],
      matchPattern:          simpleMatch,
    });
    assert.equal(r.state, 'failed');
    assert.ok(r.validationFailures.some(f => /allowedEditPaths resolved to 0/.test(f)));
  });

  it('split_e2e always reaches at most partial, never full (Phase 1 invariant)', () => {
    const r = validateTopology({
      repoRoot:              tmpRoot,
      declaredTopology:      'split_e2e',
      productSourcePatterns: { include: [], exclude: [] },
      allowedEditPaths:      ['tests/**'],
      historicalPrFilePaths: ['tests/e2e/tests/products/products.spec.ts'],
      matchPattern:          simpleMatch,
    });
    assert.equal(r.state, 'partial');
    assert.equal(topologyAllowsAuto(r), false);
  });

  it('split_e2e with PRODUCT_SOURCE_PATTERNS warns but does not fail', () => {
    const r = validateTopology({
      repoRoot:              tmpRoot,
      declaredTopology:      'split_e2e',
      productSourcePatterns: { include: ['apps/*/src/**'], exclude: [] },
      allowedEditPaths:      ['tests/**'],
      matchPattern:          simpleMatch,
    });
    assert.equal(r.state, 'partial');
    assert.ok(r.validationWarnings.some(w => /split_e2e/.test(w)));
  });

  it('handles non-existent repo root gracefully', () => {
    const r = validateTopology({
      repoRoot:              '/this/does/not/exist',
      declaredTopology:      'monorepo_e2e',
      productSourcePatterns: { include: ['apps/*/src/**'], exclude: [] },
      allowedEditPaths:      ['tests/**'],
      matchPattern:          simpleMatch,
    });
    assert.equal(r.state, 'failed');
  });
});
