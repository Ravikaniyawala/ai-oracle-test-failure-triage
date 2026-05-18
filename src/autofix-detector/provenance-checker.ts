/**
 * Provenance checker — classifies a normalized stack frame as `trusted` or
 * `untrusted` for source-attribution.
 *
 * Trust rules (priority order, first match wins):
 *   1. Bundled paths → untrusted unless source-map provenance is available.
 *   2. Vendor (node_modules / vendor/) → untrusted.
 *   3. Transient (.next/.cache/.turbo/etc) → untrusted.
 *   4. Repo-local with source-map (or recognized source extension) → trusted.
 *   5. Anything else → untrusted (low-trust default).
 *
 * Source-map presence is provided by the caller; whether/how to detect a
 * source-map sidecar is an integration concern that varies by environment
 * (CI may not have sidecars; dev runs often do).
 */

import { normalizePath } from './path-normalizer.js';
import type { NormalizedStackFrame, StackFrameProvenance } from './types.js';

export interface ProvenanceInput {
  rawFrame:         string;
  repoRoot:         string;
  /**
   * Path the bundled file's source map resolves to, if any. When provided,
   * provenance is `trusted` only if this target is repo-local AND not
   * vendor/transient/bundled itself. Presence of a sidecar source map alone
   * is NOT sufficient — the resolved target must be verified (Codex P1 #3).
   */
  sourceMapTarget?: string;
  trustedPrefixes?: string[];
}

export interface ProvenanceVerdict {
  provenance: StackFrameProvenance;
  reason:     string;
}

export function classifyFrameProvenance(input: ProvenanceInput): ProvenanceVerdict {
  const norm = normalizePath(input.rawFrame, input.repoRoot);

  if (norm.isBundled) {
    if (!input.sourceMapTarget) {
      return {
        provenance: 'untrusted',
        reason:     'bundled path without source-map target',
      };
    }
    // Verify the source-map target resolves to a real repo source — not
    // to another bundled file, vendor dependency, or transient cache.
    const targetNorm = normalizePath(input.sourceMapTarget, input.repoRoot);
    if (!targetNorm.isRepoLocal) {
      return {
        provenance: 'untrusted',
        reason:     'source-map target does not resolve to a repo-local path',
      };
    }
    if (targetNorm.isVendor || targetNorm.isTransient || targetNorm.isBundled) {
      return {
        provenance: 'untrusted',
        reason:     'source-map target resolves to vendor/transient/bundled path',
      };
    }
    return {
      provenance: 'trusted',
      reason:     'bundled path with verified repo-local source-map target',
    };
  }

  if (norm.isVendor) {
    return { provenance: 'untrusted', reason: 'vendor path (node_modules / vendor)' };
  }

  if (norm.isTransient) {
    return { provenance: 'untrusted', reason: 'transient build/cache path' };
  }

  if (input.trustedPrefixes?.some(p => norm.normalized.startsWith(p))) {
    return { provenance: 'trusted', reason: 'matches trusted prefix' };
  }

  if (norm.isRepoLocal) {
    if (
      norm.normalized.endsWith('.ts')  ||
      norm.normalized.endsWith('.tsx') ||
      norm.normalized.endsWith('.js')  ||
      norm.normalized.endsWith('.jsx') ||
      norm.normalized.endsWith('.mjs') ||
      norm.normalized.endsWith('.cjs')
    ) {
      return { provenance: 'trusted', reason: 'repo-local source file' };
    }
    return {
      provenance: 'untrusted',
      reason:     'repo-local but extension/source-map unclear',
    };
  }

  return {
    provenance: 'untrusted',
    reason:     'no trust signal (not repo-local, not source-mapped)',
  };
}

/**
 * Convenience: build a NormalizedStackFrame from a raw stack line. Combines
 * path normalization, provenance classification, and line/column parsing.
 */
export function buildNormalizedFrame(
  rawLine:  string,
  repoRoot: string,
  options?: Pick<ProvenanceInput, 'sourceMapTarget' | 'trustedPrefixes'>,
): NormalizedStackFrame {
  const positionMatch = rawLine.match(/(?:^|[\s(])([^\s()]+?):(\d+)(?::(\d+))?/);
  const filePath = positionMatch ? positionMatch[1]! : rawLine.trim();
  const line     = positionMatch?.[2] ? Number(positionMatch[2]) : undefined;
  const column   = positionMatch?.[3] ? Number(positionMatch[3]) : undefined;

  const verdict = classifyFrameProvenance({
    rawFrame:        filePath,
    repoRoot,
    sourceMapTarget: options?.sourceMapTarget,
    trustedPrefixes: options?.trustedPrefixes,
  });

  const norm = normalizePath(filePath, repoRoot);

  const frame: NormalizedStackFrame = {
    raw:        rawLine,
    file:       filePath,
    normalized: norm.normalized,
    provenance: verdict.provenance,
    reason:     verdict.reason,
  };
  if (line   !== undefined) frame.line   = line;
  if (column !== undefined) frame.column = column;
  return frame;
}
