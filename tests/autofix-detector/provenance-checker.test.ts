import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNormalizedFrame,
  classifyFrameProvenance,
} from '../../src/autofix-detector/provenance-checker.js';

const REPO = '/Users/me/oracle';

describe('classifyFrameProvenance', () => {
  it('trusts repo-local .ts files', () => {
    const v = classifyFrameProvenance({
      rawFrame: `${REPO}/src/foo.ts`,
      repoRoot: REPO,
    });
    assert.equal(v.provenance, 'trusted');
  });

  it('untrusts node_modules', () => {
    const v = classifyFrameProvenance({
      rawFrame: `${REPO}/node_modules/playwright/lib/foo.js`,
      repoRoot: REPO,
    });
    assert.equal(v.provenance, 'untrusted');
    assert.match(v.reason, /vendor/);
  });

  it('untrusts bundled without source-map target', () => {
    const v = classifyFrameProvenance({
      rawFrame: '/assets/index-abc123def.js',
      repoRoot: REPO,
    });
    assert.equal(v.provenance, 'untrusted');
    assert.match(v.reason, /source-map target/);
  });

  it('trusts bundled when source-map target resolves to repo-local source', () => {
    const v = classifyFrameProvenance({
      rawFrame:        '/assets/index-abc123def.js',
      repoRoot:        REPO,
      sourceMapTarget: `${REPO}/src/CheckoutPage.tsx`,
    });
    assert.equal(v.provenance, 'trusted');
    assert.match(v.reason, /verified repo-local/);
  });

  // P1 #3 regression suite: source-map target presence is NOT sufficient —
  // the resolved target must be verified as repo-local + not
  // vendor/transient/bundled.
  it('untrusts bundled when source-map target resolves to node_modules', () => {
    const v = classifyFrameProvenance({
      rawFrame:        '/assets/index-abc123def.js',
      repoRoot:        REPO,
      sourceMapTarget: `${REPO}/node_modules/some-pkg/dist/foo.js`,
    });
    assert.equal(v.provenance, 'untrusted');
    assert.match(v.reason, /vendor/);
  });

  it('untrusts bundled when source-map target resolves to transient cache', () => {
    const v = classifyFrameProvenance({
      rawFrame:        '/assets/index-abc123def.js',
      repoRoot:        REPO,
      sourceMapTarget: `${REPO}/.next/cache/foo.tsx`,
    });
    assert.equal(v.provenance, 'untrusted');
    assert.match(v.reason, /transient/);
  });

  it('untrusts bundled when source-map target resolves to another bundled file inside repo', () => {
    const v = classifyFrameProvenance({
      rawFrame:        '/assets/index-abc123def.js',
      repoRoot:        REPO,
      // Repo-local but bundled-shaped path (hashed asset name with hex hash)
      sourceMapTarget: `${REPO}/dist/chunk-abc123def.js`,
    });
    assert.equal(v.provenance, 'untrusted');
    assert.match(v.reason, /bundled/);
  });

  it('untrusts bundled when source-map target is outside the repo', () => {
    const v = classifyFrameProvenance({
      rawFrame:        '/assets/index-abc123def.js',
      repoRoot:        REPO,
      sourceMapTarget: '/some/other/repo/src/foo.tsx',
    });
    assert.equal(v.provenance, 'untrusted');
    assert.match(v.reason, /repo-local/);
  });

  it('untrusts transient build dirs', () => {
    const v = classifyFrameProvenance({
      rawFrame: `${REPO}/.next/cache/foo.json`,
      repoRoot: REPO,
    });
    assert.equal(v.provenance, 'untrusted');
    assert.match(v.reason, /transient/);
  });

  it('honors explicit trustedPrefixes', () => {
    const v = classifyFrameProvenance({
      rawFrame: `${REPO}/dist/main.js`,
      repoRoot: REPO,
      trustedPrefixes: ['dist/'],
    });
    assert.equal(v.provenance, 'trusted');
    assert.match(v.reason, /trusted prefix/);
  });

  it('trusts repo-local .tsx, .jsx, .mjs, .cjs', () => {
    for (const ext of ['.tsx', '.jsx', '.mjs', '.cjs']) {
      const v = classifyFrameProvenance({
        rawFrame: `${REPO}/src/foo${ext}`,
        repoRoot: REPO,
      });
      assert.equal(v.provenance, 'trusted', `expected ${ext} to be trusted`);
    }
  });

  it('does not trust unknown extensions repo-locally without source map', () => {
    const v = classifyFrameProvenance({
      rawFrame: `${REPO}/src/foo.bin`,
      repoRoot: REPO,
    });
    assert.equal(v.provenance, 'untrusted');
  });
});

describe('buildNormalizedFrame', () => {
  it('captures line and column from "at fn (file:L:C)" form', () => {
    const f = buildNormalizedFrame(
      `at ProductsPage.click (${REPO}/src/pages/ProductsPage.ts:42:13)`,
      REPO,
    );
    assert.equal(f.normalized, 'src/pages/ProductsPage.ts');
    assert.equal(f.line, 42);
    assert.equal(f.column, 13);
    assert.equal(f.provenance, 'trusted');
  });

  it('handles bare file:line:col without "at"', () => {
    const f = buildNormalizedFrame(`${REPO}/foo.ts:99:1`, REPO);
    assert.equal(f.normalized, 'foo.ts');
    assert.equal(f.line, 99);
    assert.equal(f.column, 1);
  });

  it('marks node_modules frames as untrusted', () => {
    const f = buildNormalizedFrame(
      `at run (${REPO}/node_modules/playwright/lib/foo.js:1:1)`,
      REPO,
    );
    assert.equal(f.provenance, 'untrusted');
  });
});
