import { appendFileSync } from 'fs';
import { TriageCategory, type JiraCreated, type TriageResult } from './types.js';
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

export interface SummaryOptions {
  /** Jira issues actually created during this run (execution_ok = true). */
  jirasCreated?:    JiraCreated[];
  /** Whether a Slack notification was sent. */
  slackPosted?:     boolean;
  /** Number of actions suppressed by history-based policy rules. */
  suppressionCount?: number;
}

export function writeSummary(
  results:    TriageResult[],
  totalTests: number,
  pipelineId: string,
  opts:       SummaryOptions = {},
): string {
  const blocked      = results.some(
    r => r.category === TriageCategory.REGRESSION || r.category === TriageCategory.NEW_BUG,
  );
  const verdict      = blocked ? 'BLOCKED' : 'CLEAR';
  const verdictIcon  = blocked ? '🔴' : '✅';
  const counts       = countByCategory(results);
  const { jirasCreated = [], slackPosted = false, suppressionCount = 0 } = opts;

  const lines: string[] = [];

  // ── Hero header ───────────────────────────────────────────────────────────
  lines.push(`## ${verdictIcon} AI Oracle Triage — ${verdict}`);
  lines.push('');
  lines.push(
    `**Pipeline:** \`${pipelineId}\` &nbsp;·&nbsp; ` +
    `**${totalTests}** tests analysed &nbsp;·&nbsp; ` +
    `**${results.length}** failure${results.length !== 1 ? 's' : ''} triaged`,
  );
  lines.push('');

  if (results.length === 0) {
    lines.push('> ✅ All tests passed — no failures to triage.');
    lines.push('');
    return flush(lines);
  }

  // ── Category counts — horizontal ─────────────────────────────────────────
  lines.push('| 🔴 REGRESSION | 🟠 NEW_BUG | 🟡 FLAKY | 🔵 ENV_ISSUE |');
  lines.push('|:---:|:---:|:---:|:---:|');
  lines.push(
    `| **${counts.REGRESSION}** | **${counts.NEW_BUG}** | **${counts.FLAKY}** | **${counts.ENV_ISSUE}** |`,
  );
  lines.push('');

  // ── Verdict banner ────────────────────────────────────────────────────────
  if (blocked) {
    lines.push('> 🚫 **Deploy blocked** — REGRESSION or NEW_BUG detected. Fix the failures below before merging.');
  } else {
    lines.push('> ✅ **Deploy cleared** — no regressions or new bugs. FLAKY / ENV_ISSUE failures logged for review.');
  }
  lines.push('');

  // ── Per-failure breakdown ─────────────────────────────────────────────────
  for (const category of CATEGORY_ORDER) {
    const group = results.filter(r => r.category === category);
    if (group.length === 0) continue;

    const icon = CATEGORY_ICON[category];
    lines.push('---');
    lines.push('');
    lines.push(`### ${icon} ${category} (${group.length})`);
    lines.push('');

    for (const r of group) {
      const pattern       = getRecentFailurePattern(r.errorHash);
      const seenCount     = pattern?.count ?? 0;
      const historyBadge  = seenCount > 1
        ? `⚠️ Seen **${seenCount}×** in recent history`
        : '🆕 First occurrence';
      const confidencePct = Math.round(r.confidence * 100);
      const testShort     = r.testName.length > 80 ? r.testName.slice(0, 80) + '…' : r.testName;

      // Collapsible per-failure block — summary line is the scannable at-a-glance view
      lines.push(
        `<details><summary><strong>${testShort}</strong> &nbsp;·&nbsp; ` +
        `${confidencePct}% confidence &nbsp;·&nbsp; ${historyBadge}</summary>`,
      );
      lines.push('');
      lines.push(
        `**File:** \`${r.file}\` &nbsp;·&nbsp; ` +
        `**Duration:** ${r.duration}ms`,
      );
      lines.push('');
      lines.push(`**Reasoning:** ${r.reasoning}`);
      lines.push('');
      lines.push(`**Suggested fix:** ${r.suggestedFix}`);

      if (r.errorMessage) {
        const snippet = r.errorMessage.slice(0, 500).trim();
        lines.push('');
        lines.push('<details><summary>Error detail</summary>');
        lines.push('');
        lines.push('```');
        lines.push(snippet);
        lines.push('```');
        lines.push('');
        lines.push('</details>');
      }

      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // ── Actions taken ─────────────────────────────────────────────────────────
  const actionLines: string[] = [];
  if (jirasCreated.length > 0) {
    actionLines.push(
      `🎫 **${jirasCreated.length} Jira${jirasCreated.length > 1 ? 's' : ''} created:** ` +
      jirasCreated.map(j => `[\`${j.key}\`]`).join(' · '),
    );
  }
  if (slackPosted) {
    actionLines.push('💬 **Slack notification sent**');
  }
  if (suppressionCount > 0) {
    actionLines.push(`🛡️ **${suppressionCount} duplicate action${suppressionCount > 1 ? 's' : ''} suppressed** by Oracle history rules`);
  }

  if (actionLines.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('### ⚡ Actions taken');
    lines.push('');
    for (const l of actionLines) lines.push(l);
    lines.push('');
  }

  return flush(lines);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function flush(lines: string[]): string {
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
