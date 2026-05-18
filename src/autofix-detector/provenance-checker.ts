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
  rawFrame:        string;
  repoRoot:        string;
  hasSourceMap?:   boolean;
  trustedPrefixes?: string[];
}

export interface ProvenanceVerdict {
  provenance: StackFrameProvenance;
  reason:     string;
}

export function classifyFrameProvenance(input: ProvenanceInput): ProvenanceVerdict {
  const norm = normalizePath(input.rawFrame, input.repoRoot);

  if (norm.isBundled) {
    if (input.hasSourceMap) {
      return { provenance: 'trusted', reason: 'bundled path with source-map sidecar' };
    }
    return { provenance: 'untrusted', reason: 'bundled path without source-map provenance' };
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
      input.hasSourceMap ||
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
  options?: Pick<ProvenanceInput, 'hasSourceMap' | 'trustedPrefixes'>,
): NormalizedStackFrame {
  const positionMatch = rawLine.match(/(?:^|[\s(])([^\s()]+?):(\d+)(?::(\d+))?/);
  const filePath = positionMatch ? positionMatch[1]! : rawLine.trim();
  const line     = positionMatch?.[2] ? Number(positionMatch[2]) : undefined;
  const column   = positionMatch?.[3] ? Number(positionMatch[3]) : undefined;

  const verdict = classifyFrameProvenance({
    rawFrame:        filePath,
    repoRoot,
    hasSourceMap:    options?.hasSourceMap,
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
