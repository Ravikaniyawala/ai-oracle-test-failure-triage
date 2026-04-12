import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepoIdentity } from '../src/repo-identity.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const REPO_ENV_VARS = [
  'ORACLE_REPO_ID',
  'ORACLE_REPO_NAME',
  'ORACLE_REPO_DISPLAY_NAME',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY',
];

let savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  savedEnv = {};
  for (const key of REPO_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of REPO_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

function clearRepoEnv(): void {
  for (const key of REPO_ENV_VARS) {
    delete process.env[key];
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolveRepoIdentity', () => {
  before(saveEnv);
  after(restoreEnv);
  beforeEach(clearRepoEnv);

  it('returns null when no env vars are set', () => {
    const result = resolveRepoIdentity();
    assert.equal(result, null);
  });

  it('uses ORACLE_REPO_ID over GITHUB_REPOSITORY_ID', () => {
    process.env['ORACLE_REPO_ID']         = 'override-id';
    process.env['GITHUB_REPOSITORY_ID']   = 'github-id';
    process.env['ORACLE_REPO_NAME']       = 'owner/override-repo';

    const result = resolveRepoIdentity();
    assert.ok(result !== null);
    assert.equal(result.repoId, 'override-id');
  });

  it('falls back to GITHUB_REPOSITORY_ID when ORACLE_REPO_ID is absent', () => {
    process.env['GITHUB_REPOSITORY_ID'] = '12345678';
    process.env['GITHUB_REPOSITORY']    = 'owner/my-repo';

    const result = resolveRepoIdentity();
    assert.ok(result !== null);
    assert.equal(result.repoId, '12345678');
  });

  it('derives repoDisplayName from the last segment of repoName (owner/repo)', () => {
    process.env['ORACLE_REPO_ID']   = 'abc123';
    process.env['ORACLE_REPO_NAME'] = 'my-org/cool-repo';

    const result = resolveRepoIdentity();
    assert.ok(result !== null);
    assert.equal(result.repoDisplayName, 'cool-repo');
  });

  it('uses ORACLE_REPO_DISPLAY_NAME when explicitly provided', () => {
    process.env['ORACLE_REPO_ID']           = 'abc123';
    process.env['ORACLE_REPO_NAME']         = 'my-org/cool-repo';
    process.env['ORACLE_REPO_DISPLAY_NAME'] = 'My Custom Label';

    const result = resolveRepoIdentity();
    assert.ok(result !== null);
    assert.equal(result.repoDisplayName, 'My Custom Label');
  });

  it('uses GITHUB_REPOSITORY as repoName fallback when ORACLE_REPO_NAME is absent', () => {
    process.env['ORACLE_REPO_ID']    = 'abc123';
    process.env['GITHUB_REPOSITORY'] = 'owner/fallback-repo';

    const result = resolveRepoIdentity();
    assert.ok(result !== null);
    assert.equal(result.repoName, 'owner/fallback-repo');
  });

  it('falls back repoName and displayName to repoId when only ORACLE_REPO_ID is set', () => {
    process.env['ORACLE_REPO_ID'] = 'standalone-id';

    const result = resolveRepoIdentity();
    assert.ok(result !== null);
    assert.equal(result.repoId,          'standalone-id');
    assert.equal(result.repoName,        'standalone-id');
    assert.equal(result.repoDisplayName, 'standalone-id');
  });

  it('returns correct identity with all ORACLE_REPO_* vars set', () => {
    process.env['ORACLE_REPO_ID']           = 'my-id';
    process.env['ORACLE_REPO_NAME']         = 'org/repo';
    process.env['ORACLE_REPO_DISPLAY_NAME'] = 'My Repo';

    const result = resolveRepoIdentity();
    assert.ok(result !== null);
    assert.deepEqual(result, {
      repoId:          'my-id',
      repoName:        'org/repo',
      repoDisplayName: 'My Repo',
    });
  });
});
