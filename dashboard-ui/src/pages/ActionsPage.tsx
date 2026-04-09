import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ActionTypeTrendRow, ActionVerdictSummaryRow, SuppressionSummaryRow } from '../types';
import TrendChart from '../components/TrendChart';
import DataTable, { type Column } from '../components/DataTable';
import StatCard from '../components/StatCard';

const VERDICT_COLORS: Record<string, string> = {
  approved: 'var(--color-clear)',
  rejected: 'var(--color-blocked)',
  held:     'var(--color-flaky)',
  deferred: 'var(--color-muted)',
};

const VERDICT_LABELS: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  held:     'Held',
  deferred: 'Deferred',
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
  const [trend,         setTrend]         = useState<Record<string, unknown>[]>([]);
  const [rawTrend,      setRawTrend]      = useState<ActionTypeTrendRow[]>([]);
  const [suppression,   setSuppression]   = useState<SuppressionSummaryRow[]>([]);
  const [verdictSummary,setVerdictSummary]= useState<ActionVerdictSummaryRow[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.actionsTrend(), api.actionsSuppression(), api.actionsVerdictSummary()])
      .then(([t, s, v]) => {
        setRawTrend(t);
        setTrend(pivotActions(t));
        setSuppression(s);
        setVerdictSummary(v);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: 'var(--color-muted)', padding: 24 }}>Loading…</div>;
  if (error)   return <div style={{ color: 'var(--color-blocked)', padding: 24 }}>Error: {error}</div>;

  const seriesKeys = [...new Set(rawTrend.map(r => `${r.action_type}/${r.verdict}`))];
  const totalActions = verdictSummary.reduce((sum, r) => sum + r.count, 0);

  return (
    <div>
      {/* ── Verdict summary cards ── */}
      {verdictSummary.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 14 }}>
            <StatCard
              label="Total Actions"
              value={totalActions}
            />
            {verdictSummary.map(r => (
              <StatCard
                key={r.verdict}
                label={VERDICT_LABELS[r.verdict] ?? r.verdict}
                value={r.count}
                accent={VERDICT_COLORS[r.verdict] ?? 'var(--color-muted)'}
                sub={totalActions > 0 ? `${((r.count / totalActions) * 100).toFixed(0)}% of actions` : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Action trend chart ── */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '16px 20px', marginBottom: 24 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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

      {/* ── Suppression breakdown ── */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '16px 20px' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Suppression Breakdown
        </h2>
        <p style={{ color: 'var(--color-muted)', fontSize: 12, marginBottom: 14 }}>
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
