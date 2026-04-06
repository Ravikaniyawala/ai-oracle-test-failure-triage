import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPrContext } from '../src/pr-context-loader.js';

const tmp = join(tmpdir(), 'oracle-pr-context-test');
mkdirSync(tmp, { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('loadPrContext — valid input', () => {
  it('loads minimal required fields', () => {
    const path = write('minimal.json', {
      pipelineId:   'run-123',
      filesChanged: ['src/foo.ts'],
      linkedJira:   [],
    });
    const ctx = loadPrContext(path);
    assert.ok(ctx !== null);
    assert.equal(ctx.pipelineId, 'run-123');
    assert.deepEqual(ctx.filesChanged, ['src/foo.ts']);
    assert.deepEqual(ctx.linkedJira, []);
  });

  it('loads all optional fields', () => {
    const path = write('full.json', {
      pipelineId:   'run-456',
      filesChanged: ['a.ts', 'b.ts'],
      linkedJira:   [{ key: 'DEV-42', title: 'Fix bug', issueType: 'Bug', team: 'platform' }],
      prNumber:     7,
      title:        'My PR',
      author:       'alice',
      baseBranch:   'main',
      headBranch:   'feature/x',
    });
    const ctx = loadPrContext(path);
    assert.ok(ctx !== null);
    assert.equal(ctx.prNumber, 7);
    assert.equal(ctx.title, 'My PR');
    assert.equal(ctx.author, 'alice');
    assert.equal(ctx.baseBranch, 'main');
    assert.equal(ctx.headBranch, 'feature/x');
    assert.equal(ctx.linkedJira.length, 1);
    assert.equal(ctx.linkedJira[0]!.key, 'DEV-42');
    assert.equal(ctx.linkedJira[0]!.title, 'Fix bug');
    assert.equal(ctx.linkedJira[0]!.issueType, 'Bug');
    assert.equal(ctx.linkedJira[0]!.team, 'platform');
  });

  it('accepts key-only linkedJira entries (no title/issueType)', () => {
    const path = write('key-only-jira.json', {
      pipelineId:   'run-789',
      filesChanged: [],
      linkedJira:   [{ key: 'CHECKOUT-99' }, { key: 'API-1' }],
    });
    const ctx = loadPrContext(path);
    assert.ok(ctx !== null);
    assert.equal(ctx.linkedJira.length, 2);
    assert.equal(ctx.linkedJira[0]!.key, 'CHECKOUT-99');
    assert.equal(ctx.linkedJira[1]!.key, 'API-1');
  });

  it('filters non-string entries out of filesChanged', () => {
    const path = write('mixed-files.json', {
      pipelineId:   'run-001',
      filesChanged: ['valid.ts', 42, null, 'also-valid.ts'],
      linkedJira:   [],
    });
    const ctx = loadPrContext(path);
    assert.ok(ctx !== null);
    assert.deepEqual(ctx.filesChanged, ['valid.ts', 'also-valid.ts']);
  });

  it('skips linkedJira entries that are not objects', () => {
    const path = write('jira-mixed.json', {
      pipelineId:   'run-002',
      filesChanged: [],
      linkedJira:   [{ key: 'DEV-1' }, 'not-an-object', null, 42],
    });
    const ctx = loadPrContext(path);
    assert.ok(ctx !== null);
    assert.equal(ctx.linkedJira.length, 1);
    assert.equal(ctx.linkedJira[0]!.key, 'DEV-1');
  });

  it('skips linkedJira entries missing the key field', () => {
    const path = write('jira-no-key.json', {
      pipelineId:   'run-003',
      filesChanged: [],
      linkedJira:   [{ title: 'No key here' }, { key: 'VALID-1' }],
    });
    const ctx = loadPrContext(path);
    assert.ok(ctx !== null);
    assert.equal(ctx.linkedJira.length, 1);
    assert.equal(ctx.linkedJira[0]!.key, 'VALID-1');
  });

  it('ignores unknown extra fields silently', () => {
    const path = write('extra-fields.json', {
      pipelineId:    'run-004',
      filesChanged:  [],
      linkedJira:    [],
      unknownField:  'ignored',
    });
    const ctx = loadPrContext(path);
    assert.ok(ctx !== null);
    assert.equal(ctx.pipelineId, 'run-004');
  });
});

// ---------------------------------------------------------------------------
// Error / invalid input — must return null, never throw
// ---------------------------------------------------------------------------

describe('loadPrContext — invalid input', () => {
  it('returns null for non-existent file', () => {
    const ctx = loadPrContext('/tmp/does-not-exist-ever.json');
    assert.equal(ctx, null);
  });

  it('returns null for invalid JSON', () => {
    const path = join(tmp, 'bad.json');
    writeFileSync(path, '{ not valid json }');
    assert.equal(loadPrContext(path), null);
  });

  it('returns null for JSON array at root', () => {
    const path = write('array-root.json', [{ pipelineId: 'x', filesChanged: [], linkedJira: [] }]);
    assert.equal(loadPrContext(path), null);
  });

  it('returns null when pipelineId is missing', () => {
    const path = write('no-pipeline.json', { filesChanged: [], linkedJira: [] });
    assert.equal(loadPrContext(path), null);
  });

  it('returns null when pipelineId is not a string', () => {
    const path = write('numeric-pipeline.json', { pipelineId: 123, filesChanged: [], linkedJira: [] });
    assert.equal(loadPrContext(path), null);
  });

  it('returns null when filesChanged is missing', () => {
    const path = write('no-files.json', { pipelineId: 'x', linkedJira: [] });
    assert.equal(loadPrContext(path), null);
  });

  it('returns null when linkedJira is missing', () => {
    const path = write('no-jira.json', { pipelineId: 'x', filesChanged: [] });
    assert.equal(loadPrContext(path), null);
  });

  it('returns null for empty file', () => {
    const path = join(tmp, 'empty.json');
    writeFileSync(path, '');
    assert.equal(loadPrContext(path), null);
  });
});
