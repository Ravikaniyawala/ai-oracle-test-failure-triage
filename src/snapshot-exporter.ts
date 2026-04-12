import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RepoIdentity } from './repo-identity.js';
import type { TriageResult } from './types.js';

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface SnapshotManifest {
  schema_version:    number;
  repo_id:           string;
  repo_name:         string;
  repo_display_name: string;
  updated_at:        string;
  latest_run_id:     string;
  latest_verdict:    'CLEAR' | 'BLOCKED';
  db_key:            string;
}

export interface RunEventFailure {
  test_name:  string;
  error_hash: string;
  category:   string;
  confidence: number;
}

export interface RunEvent {
  schema_version:    number;
  repo_id:           string;
  repo_name:         string;
  repo_display_name: string;
  run_id:            string;
  timestamp:         string;
  verdict:           'CLEAR' | 'BLOCKED';
  FLAKY:             number;
  REGRESSION:        number;
  NEW_BUG:           number;
  ENV_ISSUE:         number;
  failures:          RunEventFailure[];
}

export interface ExportSnapshotOptions {
  snapshotRoot: string;
  identity:     RepoIdentity;
  runId:        string;
  timestamp:    string;
  verdict:      'CLEAR' | 'BLOCKED';
  results:      TriageResult[];
  dbSourcePath: string;
}

export function exportSnapshot(opts: ExportSnapshotOptions): void {
  const { snapshotRoot, identity, runId, timestamp, verdict, results, dbSourcePath } = opts;
  const repoDir   = path.join(snapshotRoot, 'repos', identity.repoId);
  const eventsDir = path.join(repoDir, 'events');
  mkdirSync(eventsDir, { recursive: true });

  // Count categories
  const counts = { FLAKY: 0, REGRESSION: 0, NEW_BUG: 0, ENV_ISSUE: 0 };
  for (const r of results) {
    const cat = r.category as string;
    if (cat in counts) {
      const countsRec = counts as Record<string, number>;
      countsRec[cat] = (countsRec[cat] ?? 0) + 1;
    }
  }

  // Event JSON — compact failure summaries only, no raw payloads
  const event: RunEvent = {
    schema_version:    SNAPSHOT_SCHEMA_VERSION,
    repo_id:           identity.repoId,
    repo_name:         identity.repoName,
    repo_display_name: identity.repoDisplayName,
    run_id:            runId,
    timestamp,
    verdict,
    ...counts,
    failures: results.map(r => ({
      test_name:  r.testName,
      error_hash: r.errorHash,
      category:   r.category,
      confidence: r.confidence,
    })),
  };
  writeFileSync(path.join(eventsDir, `${runId}.json`), JSON.stringify(event, null, 2));

  // WAL-safe DB snapshot via VACUUM INTO.
  // copyFileSync is unsafe for a WAL-mode DB: it can copy a partially
  // checkpointed state, producing an inconsistent snapshot.
  // VACUUM INTO opens a read-only connection and writes a fully
  // checkpointed, self-consistent copy atomically.
  // VACUUM INTO rejects an existing destination, so remove it first.
  const dbKey  = `repos/${identity.repoId}/latest.db`;
  const destDb = path.join(repoDir, 'latest.db');
  rmSync(destDb, { force: true });
  const srcDb  = new Database(dbSourcePath, { readonly: true });
  try {
    srcDb.exec(`VACUUM INTO '${destDb.replace(/'/g, "''")}'`);
  } finally {
    srcDb.close();
  }

  // Manifest (always overwritten with latest run info)
  const manifest: SnapshotManifest = {
    schema_version:    SNAPSHOT_SCHEMA_VERSION,
    repo_id:           identity.repoId,
    repo_name:         identity.repoName,
    repo_display_name: identity.repoDisplayName,
    updated_at:        timestamp,
    latest_run_id:     runId,
    latest_verdict:    verdict,
    db_key:            dbKey,
  };
  writeFileSync(path.join(repoDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
