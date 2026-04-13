import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVerdict } from '../src/verdict-resolver.js';

describe('resolveVerdict', () => {
  // ── DEGRADED + pass-through ───────────────────────────────────────────────

  it('DEGRADED + pass-through → CLEAR (pipeline not blocked)', () => {
    assert.strictEqual(resolveVerdict('DEGRADED', 'pass-through'), 'CLEAR');
  });

  // ── DEGRADED + fail-closed ────────────────────────────────────────────────

  it('DEGRADED + fail-closed → BLOCKED (safe default)', () => {
    assert.strictEqual(resolveVerdict('DEGRADED', 'fail-closed'), 'BLOCKED');
  });

  // ── Normal verdicts unchanged ─────────────────────────────────────────────

  it('CLEAR + pass-through → CLEAR', () => {
    assert.strictEqual(resolveVerdict('CLEAR', 'pass-through'), 'CLEAR');
  });

  it('CLEAR + fail-closed → CLEAR', () => {
    assert.strictEqual(resolveVerdict('CLEAR', 'fail-closed'), 'CLEAR');
  });

  it('BLOCKED + pass-through → BLOCKED', () => {
    assert.strictEqual(resolveVerdict('BLOCKED', 'pass-through'), 'BLOCKED');
  });

  it('BLOCKED + fail-closed → BLOCKED', () => {
    assert.strictEqual(resolveVerdict('BLOCKED', 'fail-closed'), 'BLOCKED');
  });

  // ── Safe fallback for missing/empty raw verdict ───────────────────────────

  it('empty string → BLOCKED (safe fallback)', () => {
    assert.strictEqual(resolveVerdict('', 'fail-closed'), 'BLOCKED');
  });

  it('empty string + pass-through → BLOCKED (empty is not DEGRADED)', () => {
    // An empty verdict means the file had no verdict field — that is a data
    // problem, not a deliberate DEGRADED signal.  Still falls back to BLOCKED.
    assert.strictEqual(resolveVerdict('', 'pass-through'), 'BLOCKED');
  });
});
