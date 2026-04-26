/**
 * Decision summary artifact writer — produces oracle-decision-summary.md,
 * a human-readable record of every action proposal the Oracle considered
 * during a run, grouped by verdict, with cross-cluster advisory signals
 * and PR/change context appended when available.
 *
 * Pure function: inputs in, string + file write out. Extracted from index.ts
 * so it is testable without triggering the main() side effect.
 *
 * Sections (emitted in order):
 *   1. Approved · Rejected · Held · History-influenced  (always present)
 *   2. Cross-cluster signals                            (only when detected)
 *   3. PR / Change Context                              (only when prContext is provided)
 *
 * The artifact is skipped only when BOTH decisionLog is empty AND no
 * cross-cluster signals were detected. That way advisory signals still
 * surface for runs where every failure auto-approved and policy produced
 * no history-influenced decisions (e.g. FLAKY-only with a shared persona).
 */
import { writeFileSync } from 'fs';
import {
  type DecisionEntry,
  type PrContext,
  type PrRelevance,
  type TriageResult,
} from './types.js';
import {
  formatSignals,
  type CrossClusterSignal,
} from './cross-cluster-signals.js';

const DEFAULT_PATH =
  process.env['ORACLE_DECISION_SUMMARY_PATH'] ?? 'oracle-decision-summary.md';

export interface WriteDecisionSummaryOptions {
  /** PR / change context, when available — adds an informational section. */
  prContext?:    PrContext | null;
  /** Per-(testName:errorHash) relevance scores for the failures. */
  relevanceMap?: Map<string, PrRelevance>;
  /** Triaged failures — used to filter relevanceMap into the PR section. */
  results?:      TriageResult[];
  /** Cross-cluster advisory signals to render under their own section. */
  crossSignals?: CrossClusterSignal[];
  /** Override output path — defaults to `ORACLE_DECISION_SUMMARY_PATH` env. */
  outputPath?:   string;
}

export function writeDecisionSummary(
  decisionLog:   DecisionEntry[],
  pipelineId:    string,
  totalFailures: number,
  opts:          WriteDecisionSummaryOptions = {},
): { markdown: string; written: boolean; outputPath: string } {
  const { prContext, relevanceMap, results, crossSignals, outputPath = DEFAULT_PATH } = opts;

  const hasSignals = (crossSignals?.length ?? 0) > 0;
  if (decisionLog.length === 0 && !hasSignals) {
    return { markdown: '', written: false, outputPath };
  }

  const approved   = decisionLog.filter(d => d.verdict === 'approved');
  const rejected   = decisionLog.filter(d => d.verdict === 'rejected');
  const held       = decisionLog.filter(d => d.verdict === 'held');
  const historical = decisionLog.filter(d => d.reason.startsWith('history:'));

  const entryLine = (d: DecisionEntry): string =>
    `- \`${d.actionType}\`${d.testName ? ` for "${d.testName}"` : ''} — ${d.explanation.replace(/^[^ ]+ [^ ]+ — /, '')}`;

  const section = (title: string, entries: DecisionEntry[]): string => {
    const header = `## ${title} (${entries.length})`;
    if (entries.length === 0) return `${header}\n_none_`;
    return `${header}\n${entries.map(entryLine).join('\n')}`;
  };

  const lines: string[] = [
    `# Oracle Decision Summary — Pipeline ${pipelineId}`,
    '',
    `> ${totalFailures} failure(s) triaged · ${new Date().toISOString()}`,
    '',
    section('Approved', approved),
    '',
    section('Rejected', rejected),
    '',
    section('Held', held),
    '',
    section('History-influenced', historical),
    '',
  ];

  // Cross-cluster signals — advisory hints that the same root cause may be
  // affecting multiple clusters (shared test persona, env var, quoted value).
  // Informational only; does not influence any verdict or action proposal.
  if (hasSignals) {
    lines.push(formatSignals(crossSignals as CrossClusterSignal[]));
    lines.push('> ℹ️ Cross-cluster signals are advisory — they surface patterns for human review but do not change any Oracle decision.');
    lines.push('');
  }

  // PR / Change Context section — only when PR context was loaded.
  if (prContext !== null && prContext !== undefined) {
    lines.push('## PR / Change Context');
    lines.push('');

    const meta: string[] = [];
    if (prContext.prNumber !== undefined) meta.push(`PR #${prContext.prNumber}`);
    if (prContext.title    !== undefined) meta.push(`"${prContext.title}"`);
    if (prContext.author   !== undefined) meta.push(`by ${prContext.author}`);
    if (meta.length > 0) lines.push(`**${meta.join(' · ')}**`);

    lines.push('');
    lines.push(`**${prContext.filesChanged.length} file(s) changed** in this PR.`);

    if (prContext.linkedJira.length > 0) {
      lines.push('');
      lines.push('**Linked Jira issues:**');
      for (const j of prContext.linkedJira) {
        const jiraMeta: string[] = [];
        if (j.issueType !== undefined) jiraMeta.push(j.issueType);
        if (j.team      !== undefined) jiraMeta.push(j.team);
        const metaSuffix  = jiraMeta.length > 0 ? ` (${jiraMeta.join(' · ')})` : '';
        const titleSuffix = j.title !== undefined ? ` — ${j.title}` : '';
        lines.push(`- \`${j.key}\`${metaSuffix}${titleSuffix}`);
      }
    }

    // Per-failure relevance breakdown.
    if (relevanceMap !== undefined && results !== undefined && results.length > 0) {
      const highOrMedium = results.filter(r => {
        const rel = relevanceMap.get(`${r.testName}:${r.errorHash}`);
        return rel?.level === 'high' || rel?.level === 'medium';
      });

      lines.push('');
      lines.push('**Failure relevance to this PR:**');

      if (highOrMedium.length === 0) {
        lines.push('_No failures have high or medium relevance to the changed files._');
      } else {
        for (const r of highOrMedium) {
          const rel = relevanceMap.get(`${r.testName}:${r.errorHash}`) as PrRelevance;
          const reason = rel.reasons.length > 0 ? ` — ${rel.reasons[0]}` : '';
          lines.push(`- **${rel.level.toUpperCase()}** \`${r.testName}\`${reason}`);
        }
      }
    }

    lines.push('');
    lines.push('> ℹ️ PR context is informational only — it does not influence any Oracle decisions.');
    lines.push('');
  }

  const markdown = lines.join('\n');
  writeFileSync(outputPath, markdown);
  const signalSuffix = hasSignals ? `, ${crossSignals!.length} cross-cluster signal(s)` : '';
  console.log(`[oracle] decision summary written to ${outputPath} (${decisionLog.length} decision(s)${signalSuffix})`);
  return { markdown, written: true, outputPath };
}
