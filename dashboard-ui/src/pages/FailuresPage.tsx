import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FailureCategoryTrendRow, RecurringFailureRow } from '../types';
import TrendChart from '../components/TrendChart';
import DataTable, { type Column } from '../components/DataTable';

const CATEGORY_COLORS: Record<string, string> = {
  FLAKY:      'var(--color-flaky)',
  REGRESSION: 'var(--color-regression)',
  ENV_ISSUE:  'var(--color-env)',
  NEW_BUG:    'var(--color-newbug)',
};

function pivotFailures(rows: FailureCategoryTrendRow[]): Record<string, unknown>[] {
  const byDay = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day });
    const entry = byDay.get(r.day)!;
    entry[r.category] = r.count;
  }
  return [...byDay.values()].sort((a, b) => (a['day'] as string) < (b['day'] as string) ? -1 : 1);
}

const TOP_COLUMNS: Column<RecurringFailureRow>[] = [
  { key: 'test_name',   header: 'Test',        width: '40%' },
  { key: 'error_hash',  header: 'Error Hash',  width: '15%', render: v => <code style={{ fontSize: 11, color: 'var(--color-muted)' }}>{String(v).slice(0, 12)}</code> },
  { key: 'occurrences', header: 'Occurrences', width: '15%' },
  { key: 'last_seen',   header: 'Last Seen',   width: '30%', render: v => new Date(String(v)).toLocaleString() },
];

export default function FailuresPage() {
  const [trend,   setTrend]   = useState<Record<string, unknown>[]>([]);
  const [top,     setTop]     = useState<RecurringFailureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.failuresTrend(), api.failuresTop({ limit: 20 })])
      .then(([t, f]) => {
        setTrend(pivotFailures(t));
        setTop(f);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: 'var(--color-muted)', padding: 24 }}>Loading…</div>;
  if (error)   return <div style={{ color: 'var(--color-blocked)', padding: 24 }}>Error: {error}</div>;

  const categories = [...new Set(trend.flatMap(d => Object.keys(d).filter(k => k !== 'day')))];

  return (
    <div>
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '20px 24px', marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Failure Category Trend
        </h2>
        <TrendChart
          data={trend}
          xKey="day"
          series={categories.map(cat => ({ key: cat, color: CATEGORY_COLORS[cat] ?? '#666', label: cat }))}
          stacked
        />
      </div>

      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '20px 24px' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Top Recurring Failures
        </h2>
        <DataTable
          columns={TOP_COLUMNS}
          rows={top}
          rowKey={r => `${r.test_name}:${r.error_hash}`}
        />
      </div>
    </div>
  );
}
