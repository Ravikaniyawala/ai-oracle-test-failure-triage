/**
 * Score an exported Oracle eval dataset (JSONL) and print metrics.
 *
 * Usage:
 *   npm run eval:score -- --input evals/dataset.jsonl
 *   npm run eval:score -- --input evals/dataset.jsonl --output evals/scores.json
 *   cat evals/dataset.jsonl | npm run eval:score
 *
 * Metrics computed:
 *   block_precision   — of cases Oracle predicted should block, fraction truly blocking
 *   false_block_rate  — of truly non-blocking cases, fraction Oracle incorrectly blocked
 *   false_clear_rate  — of truly blocking cases, fraction Oracle incorrectly cleared
 *   category_accuracy — on cases with gold_category, fraction Oracle predicted correctly
 *
 * Coverage summary: totals, by evidence source, by label quality.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { EvalCase, LabelQuality } from './export-eval-dataset.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EvalMetrics {
  /** Number of cases used for metric computation (after quality filter). */
  caseCount: number;

  /** Of cases Oracle predicted as blocking, fraction with gold_should_block=true. */
  block_precision: number | null;

  /**
   * Of truly non-blocking cases (gold_should_block=false),
   * fraction that Oracle incorrectly blocked.
   */
  false_block_rate: number | null;

  /**
   * Of truly blocking cases (gold_should_block=true),
   * fraction that Oracle incorrectly cleared.
   */
  false_clear_rate: number | null;

  /**
   * On cases that have a gold_category, fraction where Oracle's
   * predicted_category matches gold_category.
   */
  category_accuracy: number | null;

  /** Breakdown of counts used to compute each metric. */
  counts: {
    predicted_block:     number;  // predicted_should_block = true
    predicted_clear:     number;  // predicted_should_block = false
    gold_block:          number;  // gold_should_block = true
    gold_clear:          number;  // gold_should_block = false
    true_positives:      number;  // predicted block AND gold block
    false_positives:     number;  // predicted block AND gold clear
    false_negatives:     number;  // predicted clear AND gold block
    true_negatives:      number;  // predicted clear AND gold clear
    with_gold_category:  number;  // cases that have gold_category set
    category_correct:    number;  // predicted_category == gold_category
  };

  /** Coverage summary. */
  coverage: {
    totalCasesInDataset:    number;
    casesAfterQualityFilter: number;
    casesByEvidenceSource:   Record<string, number>;
    casesByQuality:          Record<string, number>;
  };
}

// ── Core scorer ───────────────────────────────────────────────────────────────

/**
 * Compute metrics from an array of eval cases.
 *
 * Exported as a named function so tests can call it directly.
 */
export function scoreEvalCases(
  cases:      EvalCase[],
  minQuality: LabelQuality = 'high',
): EvalMetrics {
  const bySource:  Record<string, number> = {};
  const byQuality: Record<string, number> = {};

  for (const c of cases) {
    bySource[c.evidence_source] = (bySource[c.evidence_source] ?? 0) + 1;
    byQuality[c.label_quality]  = (byQuality[c.label_quality]  ?? 0) + 1;
  }

  // Filter by minimum quality
  const qualityOrder: Record<LabelQuality, number> = { high: 2, medium: 1 };
  const filtered = cases.filter(c => (qualityOrder[c.label_quality] ?? 0) >= qualityOrder[minQuality]);

  const counts = {
    predicted_block:    0,
    predicted_clear:    0,
    gold_block:         0,
    gold_clear:         0,
    true_positives:     0,
    false_positives:    0,
    false_negatives:    0,
    true_negatives:     0,
    with_gold_category: 0,
    category_correct:   0,
  };

  for (const c of filtered) {
    const pb = c.predicted_should_block;
    const gb = c.gold_should_block;

    if (pb) counts.predicted_block++; else counts.predicted_clear++;
    if (gb) counts.gold_block++;      else counts.gold_clear++;

    if (pb  && gb)  counts.true_positives++;
    if (pb  && !gb) counts.false_positives++;
    if (!pb && gb)  counts.false_negatives++;
    if (!pb && !gb) counts.true_negatives++;

    if (c.gold_category !== null) {
      counts.with_gold_category++;
      if (c.predicted_category === c.gold_category) counts.category_correct++;
    }
  }

  const block_precision  = counts.predicted_block > 0
    ? counts.true_positives / counts.predicted_block : null;

  const false_block_rate = counts.gold_clear > 0
    ? counts.false_positives / counts.gold_clear : null;

  const false_clear_rate = counts.gold_block > 0
    ? counts.false_negatives / counts.gold_block : null;

  const category_accuracy = counts.with_gold_category > 0
    ? counts.category_correct / counts.with_gold_category : null;

  return {
    caseCount:         filtered.length,
    block_precision,
    false_block_rate,
    false_clear_rate,
    category_accuracy,
    counts,
    coverage: {
      totalCasesInDataset:     cases.length,
      casesAfterQualityFilter: filtered.length,
      casesByEvidenceSource:   bySource,
      casesByQuality:          byQuality,
    },
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function pct(val: number | null): string {
  if (val === null) return 'n/a (no data)';
  return `${(val * 100).toFixed(1)}%`;
}

export function formatMetrics(m: EvalMetrics): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Oracle Eval — v1 Metrics');
  lines.push('========================');
  lines.push('');
  lines.push('Block decision accuracy');
  lines.push(`  block_precision   (TP / predicted_block): ${pct(m.block_precision)}`);
  lines.push(`  false_block_rate  (FP / gold_clear):      ${pct(m.false_block_rate)}`);
  lines.push(`  false_clear_rate  (FN / gold_block):      ${pct(m.false_clear_rate)}`);
  lines.push('');
  lines.push('Category accuracy');
  lines.push(`  category_accuracy (on ${m.counts.with_gold_category} labeled cases): ${pct(m.category_accuracy)}`);
  lines.push('');
  lines.push('Confusion matrix');
  lines.push(`  TP (block & gold_block):  ${m.counts.true_positives}`);
  lines.push(`  FP (block & gold_clear):  ${m.counts.false_positives}`);
  lines.push(`  FN (clear & gold_block):  ${m.counts.false_negatives}`);
  lines.push(`  TN (clear & gold_clear):  ${m.counts.true_negatives}`);
  lines.push('');
  lines.push('Coverage');
  lines.push(`  total cases in dataset:      ${m.coverage.totalCasesInDataset}`);
  lines.push(`  cases after quality filter:  ${m.coverage.casesAfterQualityFilter}`);

  const srcEntries = Object.entries(m.coverage.casesByEvidenceSource);
  if (srcEntries.length > 0) {
    lines.push('  by evidence source:');
    for (const [src, count] of srcEntries) {
      lines.push(`    ${src}: ${count}`);
    }
  }

  const qualEntries = Object.entries(m.coverage.casesByQuality);
  if (qualEntries.length > 0) {
    lines.push('  by label quality:');
    for (const [q, count] of qualEntries) {
      lines.push(`    ${q}: ${count}`);
    }
  }

  lines.push('');

  if (m.caseCount === 0) {
    lines.push('  ⚠  No eval cases found. Run eval:export first.');
    lines.push('     See evals/README.md for setup instructions.');
    lines.push('');
  }

  return lines.join('\n');
}

// ── CLI entry point ───────────────────────────────────────────────────────────

function readAllStdin(): string {
  return readFileSync('/dev/stdin', 'utf8');
}

function main(): void {
  const args       = process.argv.slice(2);
  const inputIdx   = args.indexOf('--input');
  const outputIdx  = args.indexOf('--output');
  const qualityIdx = args.indexOf('--min-quality');

  const inputPath  = inputIdx  >= 0 ? args[inputIdx  + 1] : undefined;
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
  const minQuality = (qualityIdx >= 0 ? args[qualityIdx + 1] : 'high') as LabelQuality;

  let raw: string;
  try {
    raw = inputPath ? readFileSync(inputPath, 'utf8') : readAllStdin();
  } catch (err) {
    console.error('[eval:score] could not read input:', (err as Error).message);
    process.exit(1);
  }

  const cases: EvalCase[] = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map((line, idx) => {
      try {
        return JSON.parse(line) as EvalCase;
      } catch {
        console.error(`[eval:score] skipping malformed JSONL line ${idx + 1}`);
        return null;
      }
    })
    .filter((c): c is EvalCase => c !== null);

  const metrics = scoreEvalCases(cases, minQuality);

  console.log(formatMetrics(metrics));

  if (outputPath) {
    writeFileSync(outputPath, JSON.stringify(metrics, null, 2) + '\n');
    console.error(`[eval:score] wrote metrics JSON to ${outputPath}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
