import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ActionTypeTrendRow, SuppressionSummaryRow } from '../types';
import TrendChart from '../components/TrendChart';
import DataTable, { type Column } from '../components/DataTable';

const VERDICT_COLORS: Record<string, string> = {
  approved: 'var(--color-clear)',
  rejected: 'var(--color-blocked)',
  held:     'var(--color-flaky)',
  deferred: 'var(--color-muted)',
};

function pivotActions(rows: ActionTypeTrendRow[]): Record<string, unknown>[] {
  const byDay = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day });
    const entry = byDay.get(r.day)!;
    const key   = `${r.action_type}/${r.verdict}`;
    entry[key]  = ((entry[key] as number | undefined) ?? 0) + r.count;
  }
  return [...byDay.values()].sort((a, b) => (a['day'] as string) < (b['day'] as string) ? -1 : 1);
}

const SUPPRESSION_COLS: Column<SuppressionSummaryRow>[] = [
  { key: 'decision_reason', header: 'Reason' },
  { key: 'count',           header: 'Count',  width: '80px' },
];

export default function ActionsPage() {
  const [trend,   setTrend]       = useState<Record<string, unknown>[]>([]);
  const [rawTrend, setRawTrend]   = useState<ActionTypeTrendRow[]>([]);
  const [suppression, setSuppression] = useState<SuppressionSummaryRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error,   setError]       = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.actionsTrend(), api.actionsSuppression()])
      .then(([t, s]) => {
        setRawTrend(t);
        setTrend(pivotActions(t));
        setSuppression(s);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: 'var(--color-muted)', padding: 24 }}>Loading…</div>;
  if (error)   return <div style={{ color: 'var(--color-blocked)', padding: 24 }}>Error: {error}</div>;

  const seriesKeys = [...new Set(rawTrend.map(r => `${r.action_type}/${r.verdict}`))];

  return (
    <div>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '20px 24px', marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Action Trend
        </h2>
        <TrendChart
          data={trend}
          xKey="day"
          series={seriesKeys.map(k => {
            const verdict = k.split('/')[1] ?? '';
            return { key: k, color: VERDICT_COLORS[verdict] ?? '#666', label: k };
          })}
          stacked
        />
      </div>

      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '20px 24px' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Suppression Breakdown
        </h2>
        <p style={{ color: 'var(--color-muted)', fontSize: 12, marginBottom: 16 }}>
          Actions blocked by Oracle because history indicated they would be unhelpful.
        </p>
        <DataTable
          columns={SUPPRESSION_COLS}
          rows={suppression}
          rowKey={r => r.decision_reason}
        />
      </div>
    </div>
  );
}
