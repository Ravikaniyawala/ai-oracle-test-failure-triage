/**
 * ARIA failure-context loader — reads per-failure artifacts written by a
 * consumer's Playwright reporter and parses the ARIA snapshot into the
 * structured form the locator-drift classifier consumes.
 *
 * Contract for consumers (e.g. aisle-checker's custom Playwright reporter):
 *
 *   <ORACLE_FAILURE_CONTEXT_PATH>/<test-id-slug>/data.json
 *
 * with shape:
 *
 *   {
 *     "testFile":           string,
 *     "testTitle":          string,
 *     "errorMessage":       string,
 *     "ariaSnapshot":       string,   // YAML-like, Playwright "Copy prompt" format
 *     "artifactTrustLevel": "trusted" | "partial" | "untrusted",
 *     "promptMdPath":       string?,
 *     "screenshotPath":     string?,
 *     "tracePath":          string?,
 *     // Identification — at least one of these must be present:
 *     "testName":           string?,  // canonical Oracle testName ("Suite > test")
 *     "errorHash":          string?,
 *   }
 *
 * Oracle correlates entries to failures via (testName, errorHash) when
 * provided; falls back to testFile + testTitle string-equality otherwise.
 *
 * Missing dir / malformed entries are non-fatal: the loader logs a
 * warning and returns whatever it could parse. Detector then gracefully
 * degrades to "no ARIA" → routes to hold via the existing repairability
 * gates.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { AriaSnapshotElement } from './autofix-detector/types.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface FailureContext {
  testFile?:           string;
  testTitle?:          string;
  testName?:           string;
  errorHash?:          string;
  errorMessage?:       string;
  ariaSnapshot:        AriaSnapshotElement[];
  ariaSnapshotRaw?:    string;
  artifactTrustLevel:  'trusted' | 'partial' | 'untrusted';
  promptMdPath?:       string;
  screenshotPath?:     string;
  tracePath?:          string;
}

export interface LoadFailureContextOptions {
  /** Root directory written by the consumer's Playwright reporter. */
  rootPath: string;
  /** Max files inspected; defensive cap (default 5000). */
  maxFiles?: number;
}

export interface LoadFailureContextResult {
  /** Keyed by `${testName}:${errorHash}` when both present, else `${testFile}::${testTitle}`. */
  byKey:        Map<string, FailureContext>;
  /** Total directories inspected (including malformed/skipped). */
  scanned:      number;
  /** Count of entries that loaded successfully. */
  loaded:       number;
  /** Count of malformed/skipped entries with reason. */
  skipped:      Array<{ path: string; reason: string }>;
}

// ── ARIA snapshot parser ──────────────────────────────────────────────────────

/**
 * Parses Playwright's "Copy prompt" YAML-like ARIA tree into structured
 * AriaSnapshotElement[]. The format is documented in the Playwright
 * Inspector / HTML report. Supported shapes:
 *
 *   - button "Name" [disabled]
 *   - link "Sign in"
 *   - heading "Welcome" [level=1]
 *   - list:
 *     - listitem "Item 1"
 *     - listitem "Item 2"
 *   - text: "Some text"
 *   - generic: "Container"
 *
 * Indentation is significant — children are nested under a parent that
 * ends with `:`. We capture role + accessible name + parenthesized
 * attributes; classes and test attributes are not part of this format
 * (those come from the trace's DOM snapshot, which a richer reporter
 * could populate separately).
 *
 * Returns [] for unparseable input (defensive — never throws).
 */
export function parseAriaSnapshot(raw: string): AriaSnapshotElement[] {
  if (!raw || typeof raw !== 'string') return [];
  const lines = raw.split(/\r?\n/);
  const out: AriaSnapshotElement[] = [];

  // Pattern: `- role "name" [attr=value]:` (any trailing colon is optional)
  //          `- role: "value"` for text/generic nodes
  //          `- role` (no name)
  const NODE_LINE = /^\s*-\s+([a-zA-Z][\w-]*)(?:\s+"([^"]*)")?(?:\s+\[([^\]]+)\])?\s*:?\s*("([^"]*)")?\s*$/;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(NODE_LINE);
    if (!m) continue;

    const role  = (m[1] ?? '').toLowerCase();
    const name  = m[2] ?? m[5] ?? undefined;
    const attrs = m[3];

    if (!role) continue;

    const el: AriaSnapshotElement = { role };
    if (name !== undefined) el.name = name;

    // Parse attributes inside [...]. Two shapes:
    //   - "disabled" / "selected" (presence-only)
    //   - "level=1" / "data-test=foo" (key=value)
    if (attrs) {
      const tokens = attrs.split(/\s+/).filter(t => t.length > 0);
      const testAttrs: Record<string, string> = {};
      for (const tok of tokens) {
        const eq = tok.indexOf('=');
        if (eq > 0) {
          const k = tok.slice(0, eq).toLowerCase();
          const v = tok.slice(eq + 1).replace(/^["']|["']$/g, '');
          if (k.startsWith('data-')) {
            testAttrs[k] = v;
          }
          // Other attrs (level=1, etc.) are not used by the
          // locator-drift classifier so we skip them.
        }
      }
      if (Object.keys(testAttrs).length > 0) el.testAttributes = testAttrs;
    }

    out.push(el);
  }

  return out;
}

// ── Failure-context loader ────────────────────────────────────────────────────

interface RawDataJson {
  testFile?:           unknown;
  testTitle?:          unknown;
  testName?:           unknown;
  errorHash?:          unknown;
  errorMessage?:       unknown;
  ariaSnapshot?:       unknown;
  artifactTrustLevel?: unknown;
  promptMdPath?:       unknown;
  screenshotPath?:     unknown;
  tracePath?:          unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asTrustLevel(v: unknown): 'trusted' | 'partial' | 'untrusted' {
  if (v === 'trusted' || v === 'partial' || v === 'untrusted') return v;
  return 'untrusted';
}

function makeKey(ctx: Pick<FailureContext, 'testName' | 'errorHash' | 'testFile' | 'testTitle'>): string | null {
  if (ctx.testName && ctx.errorHash) return `${ctx.testName}:${ctx.errorHash}`;
  if (ctx.testFile && ctx.testTitle) return `${ctx.testFile}::${ctx.testTitle}`;
  return null;
}

export function loadFailureContext(opts: LoadFailureContextOptions): LoadFailureContextResult {
  const result: LoadFailureContextResult = {
    byKey:   new Map(),
    scanned: 0,
    loaded:  0,
    skipped: [],
  };

  if (!existsSync(opts.rootPath)) {
    return result;
  }
  if (!statSync(opts.rootPath).isDirectory()) {
    result.skipped.push({ path: opts.rootPath, reason: 'not a directory' });
    return result;
  }

  const maxFiles = opts.maxFiles ?? 5000;
  let inspected  = 0;

  // Each subdirectory under rootPath represents one failure. data.json
  // lives at <subdir>/data.json. We don't recurse deeper — the contract
  // is one level of test-id-slug directories under rootPath.
  let entries: string[];
  try {
    entries = readdirSync(opts.rootPath);
  } catch (err) {
    result.skipped.push({ path: opts.rootPath, reason: `readdir failed: ${(err as Error).message}` });
    return result;
  }

  for (const entry of entries) {
    if (inspected >= maxFiles) {
      result.skipped.push({ path: opts.rootPath, reason: `max files cap (${maxFiles}) reached` });
      break;
    }
    inspected++;
    const subdir = join(opts.rootPath, entry);
    let isDir = false;
    try { isDir = statSync(subdir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    result.scanned++;

    const dataJsonPath = join(subdir, 'data.json');
    if (!existsSync(dataJsonPath)) {
      result.skipped.push({ path: subdir, reason: 'no data.json' });
      continue;
    }

    let raw: RawDataJson;
    try {
      raw = JSON.parse(readFileSync(dataJsonPath, 'utf8')) as RawDataJson;
    } catch (err) {
      result.skipped.push({ path: dataJsonPath, reason: `invalid JSON: ${(err as Error).message}` });
      continue;
    }

    const ariaSnapshotRaw = asString(raw.ariaSnapshot);
    const ariaSnapshot    = ariaSnapshotRaw ? parseAriaSnapshot(ariaSnapshotRaw) : [];

    const ctx: FailureContext = {
      ariaSnapshot,
      artifactTrustLevel: asTrustLevel(raw.artifactTrustLevel),
    };
    const testFile     = asString(raw.testFile);
    const testTitle    = asString(raw.testTitle);
    const testName     = asString(raw.testName);
    const errorHash    = asString(raw.errorHash);
    const errorMessage = asString(raw.errorMessage);
    const promptMd     = asString(raw.promptMdPath);
    const screenshot   = asString(raw.screenshotPath);
    const trace        = asString(raw.tracePath);

    if (testFile)        ctx.testFile        = testFile;
    if (testTitle)       ctx.testTitle       = testTitle;
    if (testName)        ctx.testName        = testName;
    if (errorHash)       ctx.errorHash       = errorHash;
    if (errorMessage)    ctx.errorMessage    = errorMessage;
    if (ariaSnapshotRaw) ctx.ariaSnapshotRaw = ariaSnapshotRaw;
    if (promptMd)        ctx.promptMdPath    = promptMd;
    if (screenshot)      ctx.screenshotPath  = screenshot;
    if (trace)           ctx.tracePath       = trace;

    const key = makeKey(ctx);
    if (!key) {
      result.skipped.push({
        path: dataJsonPath,
        reason: 'no testName+errorHash and no testFile+testTitle to key on',
      });
      continue;
    }
    result.byKey.set(key, ctx);
    result.loaded++;
  }

  return result;
}

/**
 * Convenience helper for Oracle's runtime: look up a single failure's
 * context by canonical (testName, errorHash) identifier first, with
 * fallback to (testFile, testTitle) when the reporter didn't populate
 * the canonical fields.
 */
export function lookupFailureContext(
  loaded:    LoadFailureContextResult,
  testName:  string,
  errorHash: string,
  testFile?: string,
): FailureContext | undefined {
  const primary = loaded.byKey.get(`${testName}:${errorHash}`);
  if (primary) return primary;
  // Fallback: match by testFile + testTitle if reporter only had those.
  // We don't have testTitle here directly — Oracle's testName is
  // `"<file> > <title>"` in many cases. Best-effort: try lookups where
  // the key is testFile::<anything> by walking the map; if we have
  // testFile, prefer entries whose stored testFile matches.
  if (testFile) {
    for (const [, ctx] of loaded.byKey) {
      if (ctx.testFile === testFile && testName.endsWith(ctx.testTitle ?? '')) {
        return ctx;
      }
    }
  }
  return undefined;
}
