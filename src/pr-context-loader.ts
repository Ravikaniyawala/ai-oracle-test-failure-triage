import { readFileSync } from 'fs';
import { type LinkedJira, type PrContext } from './types.js';

/**
 * Load and validate the PR context JSON file at the given path.
 *
 * Returns null (never throws) when:
 *   - the file does not exist
 *   - the file cannot be parsed as JSON
 *   - the parsed value is missing required fields
 *
 * The file must be a JSON object with at minimum:
 *   { pipelineId: string, filesChanged: string[], linkedJira: unknown[] }
 *
 * Unknown extra fields are silently ignored.
 */
export function loadPrContext(filePath: string): PrContext | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    console.warn(`[pr-context] could not read file: ${filePath}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[pr-context] invalid JSON in: ${filePath}`);
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.warn('[pr-context] expected a JSON object at root level');
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['pipelineId'] !== 'string') {
    console.warn('[pr-context] missing required field: pipelineId');
    return null;
  }

  if (!Array.isArray(obj['filesChanged'])) {
    console.warn('[pr-context] missing required field: filesChanged (must be array)');
    return null;
  }

  if (!Array.isArray(obj['linkedJira'])) {
    console.warn('[pr-context] missing required field: linkedJira (must be array)');
    return null;
  }

  const filesChanged: string[] = obj['filesChanged']
    .filter((f): f is string => typeof f === 'string');

  const rawJira = obj['linkedJira'] as unknown[];
  const validJiraObjects = rawJira.filter(
    (j): j is Record<string, unknown> => typeof j === 'object' && j !== null && !Array.isArray(j),
  );
  const droppedCount = rawJira.length - validJiraObjects.length;
  if (droppedCount > 0) {
    console.warn(`[pr-context] ${droppedCount} linkedJira entry/entries skipped (not an object)`);
  }

  // Only key is required — title, issueType, team are optional.
  // CI workflows often emit key-only Jira refs; dropping them would silently
  // discard valid linked issue information.
  const linkedJiraWithKey = validJiraObjects.filter(j => typeof j['key'] === 'string');
  const droppedNoKey = validJiraObjects.length - linkedJiraWithKey.length;
  if (droppedNoKey > 0) {
    console.warn(`[pr-context] ${droppedNoKey} linkedJira entry/entries skipped (missing key)`);
  }

  const linkedJira: LinkedJira[] = linkedJiraWithKey.map(j => ({
    key:       j['key']       as string,
    title:     typeof j['title']     === 'string' ? j['title']     : undefined,
    issueType: typeof j['issueType'] === 'string' ? j['issueType'] : undefined,
    team:      typeof j['team']      === 'string' ? j['team']      : undefined,
  }));

  const ctx: PrContext = {
    pipelineId:  obj['pipelineId'] as string,
    filesChanged,
    linkedJira,
  };

  if (typeof obj['prNumber']   === 'number') ctx.prNumber   = obj['prNumber'];
  if (typeof obj['title']      === 'string') ctx.title      = obj['title'];
  if (typeof obj['author']     === 'string') ctx.author     = obj['author'];
  if (typeof obj['baseBranch'] === 'string') ctx.baseBranch = obj['baseBranch'];
  if (typeof obj['headBranch'] === 'string') ctx.headBranch = obj['headBranch'];

  return ctx;
}
