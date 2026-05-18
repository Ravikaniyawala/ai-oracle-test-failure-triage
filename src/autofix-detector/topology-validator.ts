/**
 * Topology validator — verifies a declared `ORACLE_TEST_REPO_TOPOLOGY`
 * matches reality before any autofix gating runs.
 *
 * Three states:
 *   - full:    structural checks pass AND historical PR context proves
 *              app-change visibility
 *   - partial: structural checks pass but no historical PR context yet
 *              (new repo); auto mode stays disallowed until upgraded
 *   - failed:  structural checks fail (paths don't resolve); operator
 *              config fix required
 *
 * `split_e2e` topology can never reach `full` in Phase 1 regardless of
 * history — cross-repo deploy correlation (Phase 4+) is the unblocker.
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import type { RepoTopology, TopologyValidationResult } from './types.js';

export interface TopologyValidatorOptions {
  repoRoot:               string;
  declaredTopology:       RepoTopology;
  productSourcePatterns:  { include: readonly string[]; exclude: readonly string[] };
  allowedEditPaths:       readonly string[];
  /** Historical PR context paths from prior Oracle runs (empty = no history). */
  historicalPrFilePaths?: readonly string[];
  /** Glob-matcher function — caller injects to avoid hard dep on picomatch. */
  matchPattern:           (file: string, pattern: string) => boolean;
  /** Defensive cap on files scanned per topology validation run. */
  maxFilesScanned?:       number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.idea', '.vscode',
  'dist', 'build', 'out', 'target', '.next',
  '.turbo', '.vite', '.parcel-cache', '.nyc_output', 'coverage',
]);

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function walkRepoFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full));
      }
    }
  }

  walk(root);
  return out;
}

function matchAny(
  file:     string,
  patterns: readonly string[],
  match:    (f: string, p: string) => boolean,
): boolean {
  if (patterns.length === 0) return false;
  return patterns.some(p => match(file, p));
}

export function validateTopology(opts: TopologyValidatorOptions): TopologyValidationResult {
  const maxFiles = opts.maxFilesScanned ?? 50_000;
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(opts.repoRoot)) {
    return {
      declared:                    opts.declaredTopology,
      state:                       'failed',
      validationFailures:          [`repoRoot does not exist: ${opts.repoRoot}`],
      validationWarnings:          [],
      resolvedAllowedEditPaths:    [],
      resolvedProductSourcePaths:  [],
      appChangeVisibilityProven:   false,
    };
  }

  if (!statSync(opts.repoRoot).isDirectory()) {
    return {
      declared:                    opts.declaredTopology,
      state:                       'failed',
      validationFailures:          [`repoRoot is not a directory: ${opts.repoRoot}`],
      validationWarnings:          [],
      resolvedAllowedEditPaths:    [],
      resolvedProductSourcePaths:  [],
      appChangeVisibilityProven:   false,
    };
  }

  const files = walkRepoFiles(opts.repoRoot, maxFiles);
  if (files.length >= maxFiles) {
    warnings.push(
      `file scan hit cap of ${maxFiles}; validation may be incomplete`,
    );
  }

  // ── Resolve allowedEditPaths ───────────────────────────────────────────
  const allowedMatched = files.filter(
    f => matchAny(f, opts.allowedEditPaths, opts.matchPattern),
  );
  if (allowedMatched.length === 0) {
    failures.push(
      `allowedEditPaths resolved to 0 files; check globs match repo layout. ` +
      `Patterns: ${opts.allowedEditPaths.join(', ')}`,
    );
  }

  // ── Resolve PRODUCT_SOURCE_PATTERNS (skipped for split_e2e) ────────────
  let productMatched: string[] = [];
  if (opts.declaredTopology === 'split_e2e') {
    if (opts.productSourcePatterns.include.length > 0) {
      warnings.push(
        'split_e2e topology with non-empty PRODUCT_SOURCE_PATTERNS; ' +
        'usually app source is in a separate repo. Empty include list ' +
        'is recommended.',
      );
    }
  } else {
    const included = files.filter(
      f => matchAny(f, opts.productSourcePatterns.include, opts.matchPattern),
    );
    productMatched = included.filter(
      f => !matchAny(f, opts.productSourcePatterns.exclude, opts.matchPattern),
    );
    if (productMatched.length === 0) {
      failures.push(
        `PRODUCT_SOURCE_PATTERNS resolved to 0 files after exclusions; ` +
        `either topology was misdeclared as ${opts.declaredTopology} or ` +
        `the patterns are wrong. ` +
        `Include: ${opts.productSourcePatterns.include.join(', ')} | ` +
        `Exclude: ${opts.productSourcePatterns.exclude.join(', ')}`,
      );
    }
  }

  if (failures.length > 0) {
    return {
      declared:                    opts.declaredTopology,
      state:                       'failed',
      validationFailures:          failures,
      validationWarnings:          warnings,
      resolvedAllowedEditPaths:    allowedMatched.slice(0, 20),
      resolvedProductSourcePaths:  productMatched.slice(0, 20),
      appChangeVisibilityProven:   false,
    };
  }

  // ── App-change visibility ──────────────────────────────────────────────
  let appChangeVisibilityProven = false;
  if (opts.declaredTopology === 'split_e2e') {
    appChangeVisibilityProven = false;
  } else {
    const historical = opts.historicalPrFilePaths ?? [];
    appChangeVisibilityProven = historical.some(
      f =>
        matchAny(f, opts.productSourcePatterns.include, opts.matchPattern) &&
        !matchAny(f, opts.productSourcePatterns.exclude, opts.matchPattern),
    );
  }

  // ── Final state ────────────────────────────────────────────────────────
  let state: TopologyValidationResult['state'];
  if (opts.declaredTopology === 'split_e2e') {
    state = 'partial';
    warnings.push(
      'topology_app_change_visibility_unproven: split_e2e cannot prove ' +
      'app-change visibility within this repo. Auto mode is disallowed ' +
      'in Phase 1; unblocked by Phase 4 cross-repo deploy correlation.',
    );
  } else if (appChangeVisibilityProven) {
    state = 'full';
  } else {
    state = 'partial';
    warnings.push(
      'topology_app_change_visibility_unproven: no historical PR context ' +
      'overlapping with PRODUCT_SOURCE_PATTERNS yet. Will upgrade to full ' +
      'once a PR touches product source.',
    );
  }

  return {
    declared:                    opts.declaredTopology,
    state,
    validationFailures:          failures,
    validationWarnings:          warnings,
    resolvedAllowedEditPaths:    allowedMatched.slice(0, 20),
    resolvedProductSourcePaths:  productMatched.slice(0, 20),
    appChangeVisibilityProven,
  };
}

/**
 * Derive `topologyAllowsAuto` from a validation result. Phase 1 rule:
 * only `full` state for monorepo topologies permits auto mode. Any other
 * combination disallows auto.
 */
export function topologyAllowsAuto(result: TopologyValidationResult): boolean {
  if (result.state !== 'full') return false;
  if (result.declared === 'split_e2e') return false;
  return true;
}
