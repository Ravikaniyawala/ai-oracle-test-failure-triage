import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../../src/autofix-detector/path-normalizer.js';

const REPO = '/Users/me/oracle';

describe('normalizePath', () => {
  it('relativizes absolute paths under repo root', () => {
    const r = normalizePath(`${REPO}/src/foo.ts`, REPO);
    assert.equal(r.normalized, 'src/foo.ts');
    assert.equal(r.isRepoLocal, true);
  });

  it('strips file:// prefix', () => {
    const r = normalizePath(`file://${REPO}/foo.ts`, REPO);
    assert.equal(r.normalized, 'foo.ts');
    assert.equal(r.isRepoLocal, true);
  });

  it('strips trailing line:col', () => {
    const r = normalizePath(`${REPO}/foo.ts:42:13`, REPO);
    assert.equal(r.normalized, 'foo.ts');
  });

  it('handles paren-wrapped stack-style paths', () => {
    const r = normalizePath(`(${REPO}/foo.ts:42:13)`, REPO);
    assert.equal(r.normalized, 'foo.ts');
  });

  it('flags node_modules as vendor', () => {
    const r = normalizePath(`${REPO}/node_modules/playwright/lib/foo.js`, REPO);
    assert.equal(r.isVendor, true);
  });

  it('flags webpack:// as bundled', () => {
    const r = normalizePath('webpack:///./src/Button.tsx', REPO);
    assert.equal(r.isBundled, true);
  });

  it('flags hashed asset names as bundled', () => {
    const r = normalizePath('/assets/index-abc123def.js', REPO);
    assert.equal(r.isBundled, true);
  });

  it('flags transient build dirs (.next, .cache, .turbo)', () => {
    for (const d of ['.next', '.cache', '.turbo', '.parcel-cache', '.vite']) {
      const r = normalizePath(`${REPO}/${d}/foo.json`, REPO);
      assert.equal(r.isTransient, true, `expected ${d} to be transient`);
    }
  });

  it('handles arbitrary relative paths', () => {
    const r = normalizePath('./src/App.tsx', REPO);
    assert.equal(r.normalized, 'src/App.tsx');
    assert.equal(r.isRepoLocal, true);
  });

  it('marks paths outside repo as non-repo-local', () => {
    const r = normalizePath('/some/other/path/foo.ts', REPO);
    assert.equal(r.isRepoLocal, false);
  });

  it('handles empty input safely', () => {
    const r = normalizePath('', REPO);
    assert.equal(r.normalized, '');
    assert.equal(r.isRepoLocal, false);
  });

  it('strips query strings and hash fragments', () => {
    const r = normalizePath(`${REPO}/foo.ts?sourcemap=true#L42`, REPO);
    assert.equal(r.normalized, 'foo.ts');
  });
});
