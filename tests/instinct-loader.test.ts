import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadInstincts } from '../src/instinct-loader.js';

const tmp = join(tmpdir(), 'oracle-instinct-test');
mkdirSync(tmp, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

function writeInstinct(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('loadInstincts — valid input', () => {
  it('returns empty array when directory does not exist', () => {
    const instincts = loadInstincts('/tmp/does-not-exist-oracle-instincts');
    assert.deepEqual(instincts, []);
  });

  it('returns empty array for empty directory', () => {
    const dir = join(tmp, 'empty-dir');
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(loadInstincts(dir), []);
  });

  it('loads bullet points under ## Pattern section', () => {
    const dir = join(tmp, 'pattern-section');
    mkdirSync(dir, { recursive: true });
    writeInstinct(dir, 'test.md', [
      '## Pattern',
      '- tests with Delayed in name are usually FLAKY',
      '- bulk endpoints returning 404 are NEW_BUG',
      '',
    ].join('\n'));
    const instincts = loadInstincts(dir);
    assert.equal(instincts.length, 2);
    assert.ok(instincts.some(i => i.includes('Delayed')));
    assert.ok(instincts.some(i => i.includes('bulk')));
  });

  it('loads bullet points under ## Action section', () => {
    const dir = join(tmp, 'action-section');
    mkdirSync(dir, { recursive: true });
    writeInstinct(dir, 'actions.md', [
      '## Action',
      '- create Jira for REGRESSION above 0.85 confidence',
      '',
    ].join('\n'));
    const instincts = loadInstincts(dir);
    assert.equal(instincts.length, 1);
    assert.ok(instincts[0]!.includes('Jira'));
  });

  it('ignores lines outside ## Pattern and ## Action sections', () => {
    const dir = join(tmp, 'mixed-sections');
    mkdirSync(dir, { recursive: true });
    writeInstinct(dir, 'mixed.md', [
      '## Overview',
      '- this should be ignored',
      '## Pattern',
      '- this should be included',
      '## Notes',
      '- this should also be ignored',
    ].join('\n'));
    const instincts = loadInstincts(dir);
    assert.equal(instincts.length, 1);
    assert.ok(instincts[0]!.includes('included'));
  });

  it('loads from multiple .md files', () => {
    const dir = join(tmp, 'multi-file');
    mkdirSync(dir, { recursive: true });
    writeInstinct(dir, 'first.md', '## Pattern\n- instinct from first file\n');
    writeInstinct(dir, 'second.md', '## Pattern\n- instinct from second file\n');
    const instincts = loadInstincts(dir);
    assert.equal(instincts.length, 2);
    assert.ok(instincts.some(i => i.includes('first')));
    assert.ok(instincts.some(i => i.includes('second')));
  });

  it('ignores non-.md files', () => {
    const dir = join(tmp, 'non-md');
    mkdirSync(dir, { recursive: true });
    writeInstinct(dir, 'instinct.md',  '## Pattern\n- valid md instinct\n');
    writeInstinct(dir, 'instinct.txt', '## Pattern\n- txt file should be ignored\n');
    writeInstinct(dir, 'instinct.json', JSON.stringify({ pattern: '- json ignored' }));
    const instincts = loadInstincts(dir);
    assert.equal(instincts.length, 1);
    assert.ok(instincts[0]!.includes('valid md'));
  });

  it('only collects lines starting with -', () => {
    const dir = join(tmp, 'non-bullet');
    mkdirSync(dir, { recursive: true });
    writeInstinct(dir, 'test.md', [
      '## Pattern',
      '- bullet line included',
      'plain line not included',
      '  indented line not included',
      '* asterisk not included',
    ].join('\n'));
    const instincts = loadInstincts(dir);
    assert.equal(instincts.length, 1);
    assert.ok(instincts[0]!.startsWith('-'));
  });

  it('uses default .instincts path when no argument given', () => {
    // Default path likely does not exist in test environment — should return [] not throw.
    assert.doesNotThrow(() => loadInstincts());
  });
});
