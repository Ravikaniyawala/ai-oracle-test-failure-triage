import { appendFileSync } from 'fs';
import { TriageCategory, type TriageResult } from './types.js';
import { getRecentFailurePattern } from './state-store.js';

const SUMMARY_PATH = process.env['GITHUB_STEP_SUMMARY'];

const CATEGORY_ICON: Record<TriageCategory, string> = {
  [TriageCategory.REGRESSION]: '🔴',
  [TriageCategory.NEW_BUG]:    '🟠',
  [TriageCategory.FLAKY]:      '🟡',
  [TriageCategory.ENV_ISSUE]:  '🔵',
};

const CATEGORY_ORDER: TriageCategory[] = [
  TriageCategory.REGRESSION,
  TriageCategory.NEW_BUG,
  TriageCategory.FLAKY,
  TriageCategory.ENV_ISSUE,
];

export function writeSummary(
  results: TriageResult[],
  totalTests: number,
  pipelineId: string,
): string {

  const blocked = results.some(
    r => r.category === TriageCategory.REGRESSION || r.category === TriageCategory.NEW_BUG,
  );
  const verdict     = blocked ? 'BLOCKED' : 'CLEAR';
  const verdictIcon = blocked ? '🔴' : '✅';
  const counts      = countByCategory(results);

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`## ${verdictIcon} AI Oracle Triage — ${verdict}`);
  lines.push('');
  lines.push(
    `**Pipeline:** \`${pipelineId}\` &nbsp;|&nbsp; ` +
    `**Tests analysed:** ${totalTests} &nbsp;|&nbsp; ` +
    `**Failures triaged:** ${results.length}`,
  );
  lines.push('');

  // ── Summary counts table ──────────────────────────────────────────────────
  lines.push('| Category | Count |');
  lines.push('|---|:---:|');
  lines.push(`| 🔴 REGRESSION | **${counts.REGRESSION}** |`);
  lines.push(`| 🟠 NEW_BUG    | **${counts.NEW_BUG}**    |`);
  lines.push(`| 🟡 FLAKY      | **${counts.FLAKY}**      |`);
  lines.push(`| 🔵 ENV_ISSUE  | **${counts.ENV_ISSUE}**  |`);
  lines.push('');

  if (blocked) {
    lines.push('> 🚫 **Deploy blocked** — REGRESSION or NEW_BUG detected. Fix the failures below before merging.');
  } else {
    lines.push('> ✅ **Deploy cleared** — no regressions or new bugs. FLAKY/ENV issues logged for review.');
  }

  // ── Per-failure breakdown grouped by category ─────────────────────────────
  for (const category of CATEGORY_ORDER) {
    const group = results.filter(r => r.category === category);
    if (group.length === 0) continue;

    const icon = CATEGORY_ICON[category];
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`### ${icon} ${category} (${group.length})`);

    for (const r of group) {
      const pattern      = getRecentFailurePattern(r.errorHash);
      const historyNote  = pattern && pattern.count > 1
        ? `⚠️ Seen **${pattern.count}x** in recent history`
        : '🆕 First occurrence in history';
      const confidencePct = Math.round(r.confidence * 100);

      lines.push('');
      lines.push(`#### \`${r.testName}\``);
      lines.push('');
      lines.push('| | |');
      lines.push('|---|---|');
      lines.push(`| **Confidence** | ${confidencePct}% |`);
      lines.push(`| **File** | \`${r.file}\` |`);
      lines.push(`| **Duration** | ${r.duration}ms |`);
      lines.push(`| **History** | ${historyNote} |`);
      lines.push('');
      lines.push(`**Reasoning:** ${r.reasoning}`);
      lines.push('');
      lines.push(`**Suggested fix:** ${r.suggestedFix}`);

      if (r.errorMessage) {
        const snippet = r.errorMessage.slice(0, 400).trim();
        lines.push('');
        lines.push('<details><summary>Error detail</summary>');
        lines.push('');
        lines.push('```');
        lines.push(snippet);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
      }
    }
  }

  lines.push('');
  const markdown = lines.join('\n') + '\n';
  if (SUMMARY_PATH) appendFileSync(SUMMARY_PATH, markdown);
  return markdown;
}

function countByCategory(results: TriageResult[]): Record<TriageCategory, number> {
  const counts: Record<TriageCategory, number> = {
    [TriageCategory.REGRESSION]: 0,
    [TriageCategory.NEW_BUG]:    0,
    [TriageCategory.FLAKY]:      0,
    [TriageCategory.ENV_ISSUE]:  0,
  };
  for (const r of results) counts[r.category]++;
  return counts;
}
