import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmp = join(tmpdir(), 'oracle-feedback-test');
const DB  = join(tmp, 'test-state.db');
mkdirSync(tmp, { recursive: true });

// Set DB path before importing state-store (read at module load time).
process.env['ORACLE_STATE_DB_PATH'] = DB;

// better-sqlite3 v12 requires Node 20+. Guard the import so the test file
// does not crash on older local runtimes. CI always runs Node 24.
type IngestFn = (path: string) => number;
let ingestFeedback: IngestFn | null = null;
let dbAvailable = false;

try {
  const fp    = await import('../src/feedback-processor.js');
  const store = await import('../src/state-store.js');
  store.initDb();
  ingestFeedback = fp.ingestFeedback;
  dbAvailable    = true;
} catch {
  console.warn('[test] better-sqlite3 unavailable on this Node version — DB tests skipped');
}

const describeMaybe = dbAvailable ? describe : describe.skip;

after(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

const VALID_FEEDBACK = {
  feedback_type: 'jira_closed_confirmed',
  pipeline_id:   'run-001',
  test_name:     'MyTest > case',
  error_hash:    'abc123',
  notes:         'confirmed by dev team',
};

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describeMaybe('ingestFeedback — valid input', () => {
  it('ingests a single feedback object and returns count 1', () => {
    const path = write('single.json', VALID_FEEDBACK);
    const count = ingestFeedback!(path);
    assert.equal(count, 1);
  });

  it('ingests an array of feedback and returns correct count', () => {
    const path = write('array.json', [
      VALID_FEEDBACK,
      { ...VALID_FEEDBACK, feedback_type: 'retry_passed', notes: 'retry worked' },
    ]);
    const count = ingestFeedback!(path);
    assert.equal(count, 2);
  });

  it('accepts all valid feedback_type values', () => {
    const validTypes = [
      'jira_closed_duplicate',
      'jira_closed_confirmed',
      'classification_corrected',
      'action_overridden',
      'retry_passed',
      'retry_failed',
    ];
    for (const feedback_type of validTypes) {
      const path = write(`type-${feedback_type}.json`, { feedback_type });
      const count = ingestFeedback!(path);
      assert.equal(count, 1, `expected 1 for feedback_type: ${feedback_type}`);
    }
  });

  it('accepts feedback with only feedback_type (all other fields optional)', () => {
    const path = write('minimal.json', { feedback_type: 'retry_passed' });
    const count = ingestFeedback!(path);
    assert.equal(count, 1);
  });

  it('ingests feedback with action_fingerprint field', () => {
    const path = write('with-fingerprint.json', {
      ...VALID_FEEDBACK,
      action_fingerprint: 'fp-deadbeef',
    });
    const count = ingestFeedback!(path);
    assert.equal(count, 1);
  });

  it('ingests feedback with old_value and new_value fields', () => {
    const path = write('with-values.json', {
      feedback_type: 'classification_corrected',
      old_value:     'REGRESSION',
      new_value:     'FLAKY',
    });
    const count = ingestFeedback!(path);
    assert.equal(count, 1);
  });
});

// ---------------------------------------------------------------------------
// Invalid entries — skip bad, never throw
// ---------------------------------------------------------------------------

describeMaybe('ingestFeedback — invalid entries', () => {
  it('skips entry with unknown feedback_type and returns 0', () => {
    const path = write('unknown-type.json', { feedback_type: 'not_a_real_type' });
    const count = ingestFeedback!(path);
    assert.equal(count, 0);
  });

  it('skips entry missing feedback_type entirely', () => {
    const path = write('no-type.json', { pipeline_id: 'run-x', test_name: 'test' });
    const count = ingestFeedback!(path);
    assert.equal(count, 0);
  });

  it('skips null entries in array', () => {
    const path = write('with-nulls.json', [null, VALID_FEEDBACK, null]);
    const count = ingestFeedback!(path);
    assert.equal(count, 1);
  });

  it('skips invalid entries but counts valid ones in mixed array', () => {
    const path = write('mixed.json', [
      VALID_FEEDBACK,
      { feedback_type: 'bad_type' },
      { no_type: true },
      { feedback_type: 'retry_failed' },
    ]);
    const count = ingestFeedback!(path);
    assert.equal(count, 2);
  });

  it('returns 0 for empty array', () => {
    const path = write('empty.json', []);
    const count = ingestFeedback!(path);
    assert.equal(count, 0);
  });
});
