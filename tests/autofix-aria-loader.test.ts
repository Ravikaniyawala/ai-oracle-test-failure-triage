/**
 * Tests for src/autofix-aria-loader.ts — ARIA snapshot parser + per-failure
 * context loader.
 *
 * Coverage:
 *   - parseAriaSnapshot handles real Playwright "Copy prompt" shapes
 *   - parseAriaSnapshot is defensive: empty, malformed, garbage input
 *   - loadFailureContext handles missing dir / malformed JSON / missing fields
 *   - lookupFailureContext primary key + fallback key
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadFailureContext,
  lookupFailureContext,
  parseAriaSnapshot,
} from '../src/autofix-aria-loader.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'oracle-aria-loader-test-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// ── parseAriaSnapshot ─────────────────────────────────────────────────────────

describe('parseAriaSnapshot', () => {
  it('returns [] for empty/null/undefined input', () => {
    assert.deepEqual(parseAriaSnapshot(''), []);
    // @ts-expect-error
    assert.deepEqual(parseAriaSnapshot(null), []);
    // @ts-expect-error
    assert.deepEqual(parseAriaSnapshot(undefined), []);
  });

  it('parses simple role + name lines', () => {
    const raw = `- button "Checkout"\n- link "Sign in"`;
    const parsed = parseAriaSnapshot(raw);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.role, 'button');
    assert.equal(parsed[0]!.name, 'Checkout');
    assert.equal(parsed[1]!.role, 'link');
    assert.equal(parsed[1]!.name, 'Sign in');
  });

  it('parses nested lists into siblings (flat output)', () => {
    const raw = [
      '- list:',
      '  - listitem "Product A"',
      '  - listitem "Product B"',
    ].join('\n');
    const parsed = parseAriaSnapshot(raw);
    // List parent + 2 listitems = 3 entries
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0]!.role, 'list');
    assert.equal(parsed[1]!.role, 'listitem');
    assert.equal(parsed[1]!.name, 'Product A');
  });

  it('parses bracketed attributes like [disabled] and [level=1]', () => {
    const raw = [
      '- button "Save" [disabled]',
      '- heading "Welcome" [level=1]',
    ].join('\n');
    const parsed = parseAriaSnapshot(raw);
    assert.equal(parsed[0]!.role, 'button');
    assert.equal(parsed[0]!.name, 'Save');
    // We don't model "disabled" as a field today — just preserved for future
    assert.equal(parsed[1]!.name, 'Welcome');
  });

  it('captures data-* attributes into testAttributes', () => {
    const raw = `- button "Checkout" [data-test=checkout-button]`;
    const parsed = parseAriaSnapshot(raw);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0]!.testAttributes, { 'data-test': 'checkout-button' });
  });

  it('captures multiple data-* attributes', () => {
    const raw = `- button "Submit" [data-test=submit-btn data-qa=submit]`;
    const parsed = parseAriaSnapshot(raw);
    assert.deepEqual(parsed[0]!.testAttributes, {
      'data-test': 'submit-btn',
      'data-qa':   'submit',
    });
  });

  it('skips blank lines and lines without leading dash', () => {
    const raw = [
      '',
      'main:',
      '- button "Save"',
      '   ',
      'banner',
    ].join('\n');
    const parsed = parseAriaSnapshot(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.role, 'button');
  });

  it('handles roles without names', () => {
    const parsed = parseAriaSnapshot(`- generic`);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.role, 'generic');
    assert.equal(parsed[0]!.name, undefined);
  });

  it('is defensive against garbage input', () => {
    assert.deepEqual(parseAriaSnapshot('not a snapshot at all'), []);
    assert.deepEqual(parseAriaSnapshot('{json: 1}'), []);
  });
});

// ── loadFailureContext ────────────────────────────────────────────────────────

describe('loadFailureContext', () => {
  it('returns empty result when dir does not exist', () => {
    const r = loadFailureContext({ rootPath: join(tmpRoot, '_no_such_dir_') });
    assert.equal(r.byKey.size, 0);
    assert.equal(r.loaded, 0);
    assert.equal(r.skipped.length, 0);
  });

  it('returns empty result when rootPath is a file, not a dir', () => {
    const filePath = join(tmpRoot, '_a_file.txt');
    writeFileSync(filePath, 'hello');
    const r = loadFailureContext({ rootPath: filePath });
    assert.equal(r.byKey.size, 0);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0]!.reason, /not a directory/);
  });

  it('loads a well-formed data.json with testName + errorHash key', () => {
    const dir = join(tmpRoot, 'load1');
    mkdirSync(join(dir, 'test-slug-A'), { recursive: true });
    writeFileSync(
      join(dir, 'test-slug-A', 'data.json'),
      JSON.stringify({
        testName:     'Suite > test A',
        errorHash:    'abc123',
        testFile:     'tests/foo.spec.ts',
        testTitle:    'test A',
        errorMessage: 'TimeoutError',
        ariaSnapshot: `- button "Checkout" [data-test=checkout]`,
        artifactTrustLevel: 'trusted',
      }),
    );
    const r = loadFailureContext({ rootPath: dir });
    assert.equal(r.loaded, 1);
    assert.equal(r.skipped.length, 0);
    const ctx = r.byKey.get('Suite > test A:abc123');
    assert.ok(ctx);
    assert.equal(ctx.artifactTrustLevel, 'trusted');
    assert.equal(ctx.ariaSnapshot.length, 1);
    assert.equal(ctx.ariaSnapshot[0]!.role, 'button');
    assert.equal(ctx.ariaSnapshot[0]!.name, 'Checkout');
    assert.equal(ctx.ariaSnapshot[0]!.testAttributes!['data-test'], 'checkout');
  });

  it('falls back to testFile::testTitle key when canonical fields missing', () => {
    const dir = join(tmpRoot, 'load2');
    mkdirSync(join(dir, 'slug-B'), { recursive: true });
    writeFileSync(
      join(dir, 'slug-B', 'data.json'),
      JSON.stringify({
        testFile:           'tests/foo.spec.ts',
        testTitle:          'PROD-001: loads',
        ariaSnapshot:       `- button "Save"`,
        artifactTrustLevel: 'partial',
      }),
    );
    const r = loadFailureContext({ rootPath: dir });
    assert.equal(r.loaded, 1);
    const ctx = r.byKey.get('tests/foo.spec.ts::PROD-001: loads');
    assert.ok(ctx);
    assert.equal(ctx.artifactTrustLevel, 'partial');
  });

  it('skips dirs without data.json', () => {
    const dir = join(tmpRoot, 'load3');
    mkdirSync(join(dir, 'orphan-slug'), { recursive: true });
    const r = loadFailureContext({ rootPath: dir });
    assert.equal(r.loaded, 0);
    assert.ok(r.skipped.some(s => /no data\.json/.test(s.reason)));
  });

  it('skips malformed JSON without throwing', () => {
    const dir = join(tmpRoot, 'load4');
    mkdirSync(join(dir, 'bad-slug'), { recursive: true });
    writeFileSync(join(dir, 'bad-slug', 'data.json'), '{not valid json');
    const r = loadFailureContext({ rootPath: dir });
    assert.equal(r.loaded, 0);
    assert.ok(r.skipped.some(s => /invalid JSON/.test(s.reason)));
  });

  it('skips entries with no usable key', () => {
    const dir = join(tmpRoot, 'load5');
    mkdirSync(join(dir, 'keyless-slug'), { recursive: true });
    writeFileSync(
      join(dir, 'keyless-slug', 'data.json'),
      JSON.stringify({ ariaSnapshot: '- button "x"', artifactTrustLevel: 'trusted' }),
    );
    const r = loadFailureContext({ rootPath: dir });
    assert.equal(r.loaded, 0);
    assert.ok(r.skipped.some(s => /no testName\+errorHash/.test(s.reason)));
  });

  it('defaults artifactTrustLevel to "untrusted" when missing/invalid', () => {
    const dir = join(tmpRoot, 'load6');
    mkdirSync(join(dir, 'slug'), { recursive: true });
    writeFileSync(
      join(dir, 'slug', 'data.json'),
      JSON.stringify({
        testName: 'T', errorHash: 'h',
        // no artifactTrustLevel
      }),
    );
    const r = loadFailureContext({ rootPath: dir });
    const ctx = r.byKey.get('T:h');
    assert.equal(ctx!.artifactTrustLevel, 'untrusted');
  });

  it('preserves promptMdPath / screenshotPath / tracePath when provided', () => {
    const dir = join(tmpRoot, 'load7');
    mkdirSync(join(dir, 'slug'), { recursive: true });
    writeFileSync(
      join(dir, 'slug', 'data.json'),
      JSON.stringify({
        testName: 'T', errorHash: 'h',
        ariaSnapshot: '- button "x"',
        artifactTrustLevel: 'trusted',
        promptMdPath:    'test-results/x/prompt.md',
        screenshotPath:  'test-results/x/screen.png',
        tracePath:       'test-results/x/trace.zip',
      }),
    );
    const r = loadFailureContext({ rootPath: dir });
    const ctx = r.byKey.get('T:h')!;
    assert.equal(ctx.promptMdPath,    'test-results/x/prompt.md');
    assert.equal(ctx.screenshotPath,  'test-results/x/screen.png');
    assert.equal(ctx.tracePath,       'test-results/x/trace.zip');
  });
});

// ── lookupFailureContext ──────────────────────────────────────────────────────

describe('lookupFailureContext', () => {
  it('returns primary match on testName + errorHash', () => {
    const dir = join(tmpRoot, 'lookup1');
    mkdirSync(join(dir, 'slug'), { recursive: true });
    writeFileSync(join(dir, 'slug', 'data.json'), JSON.stringify({
      testName: 'Suite > test', errorHash: 'h1',
      ariaSnapshot: '- button "x"',
      artifactTrustLevel: 'trusted',
    }));
    const loaded = loadFailureContext({ rootPath: dir });
    const ctx = lookupFailureContext(loaded, 'Suite > test', 'h1');
    assert.ok(ctx);
    assert.equal(ctx!.testName, 'Suite > test');
  });

  it('returns undefined when no match', () => {
    const dir = join(tmpRoot, 'lookup2');
    mkdirSync(dir, { recursive: true });
    const loaded = loadFailureContext({ rootPath: dir });
    const ctx = lookupFailureContext(loaded, 'no', 'such');
    assert.equal(ctx, undefined);
  });

  it('falls back to testFile + testTitle when canonical key missing', () => {
    const dir = join(tmpRoot, 'lookup3');
    mkdirSync(join(dir, 'slug'), { recursive: true });
    writeFileSync(join(dir, 'slug', 'data.json'), JSON.stringify({
      testFile:           'tests/foo.spec.ts',
      testTitle:          'PROD-001 something',
      ariaSnapshot:       '- button "x"',
      artifactTrustLevel: 'trusted',
    }));
    const loaded = loadFailureContext({ rootPath: dir });
    // Oracle's testName is usually `<file>  > <title>` but the title is
    // suffix-matched by the fallback.
    const ctx = lookupFailureContext(
      loaded,
      'Suite > PROD-001 something',
      'h-not-used',
      'tests/foo.spec.ts',
    );
    assert.ok(ctx, 'fallback should match on testFile + testTitle suffix');
    assert.equal(ctx!.testFile, 'tests/foo.spec.ts');
  });
});
