import { useEffect, useState } from 'react';
import { api } from '../api';
import type { OverviewStats, RunVerdictTrendRow } from '../types';
import StatCard from '../components/StatCard';
import TrendChart from '../components/TrendChart';

// Pivot RunVerdictTrendRow[] into recharts-friendly format
function pivotTrend(rows: RunVerdictTrendRow[]): Record<string, unknown>[] {
  const byDay = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day });
    const entry = byDay.get(r.day)!;
    entry[r.verdict] = r.count;
  }
  return [...byDay.values()].sort((a, b) => (a['day'] as string) < (b['day'] as string) ? -1 : 1);
}

export default function OverviewPage() {
  const [stats,     setStats]     = useState<OverviewStats | null>(null);
  const [trend,     setTrend]     = useState<Record<string, unknown>[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.overview(), api.runsTrend()])
      .then(([s, t]) => {
        setStats(s);
        setTrend(pivotTrend(t));
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: 'var(--color-muted)', padding: 24 }}>Loading…</div>;
  if (error)   return <div style={{ color: 'var(--color-blocked)', padding: 24 }}>Error: {error}</div>;
  if (!stats)  return null;

  const clearPct = `${(stats.clearRate * 100).toFixed(1)}%`;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 16, marginBottom: 32 }}>
        <StatCard label="Total Runs"         value={stats.totalRuns}         />
        <StatCard label="Clear Rate"         value={clearPct}                accent="var(--color-clear)" />
        <StatCard label="Total Failures"     value={stats.totalFailures}     accent={stats.totalFailures > 0 ? 'var(--color-blocked)' : undefined} />
        <StatCard label="Suppressions Saved" value={stats.suppressionsSaved} sub="duplicate actions blocked" />
      </div>

      {Object.keys(stats.categoryBreakdown).length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Failure Categories
          </h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {Object.entries(stats.categoryBreakdown).map(([cat, count]) => (
              <StatCard key={cat} label={cat} value={count} />
            ))}
          </div>
        </div>
      )}

      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '20px 24px' }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Run Trend
        </h2>
        <TrendChart
          data={trend}
          xKey="day"
          series={[
            { key: 'CLEAR',   color: 'var(--color-clear)',   label: 'Clear'   },
            { key: 'BLOCKED', color: 'var(--color-blocked)', label: 'Blocked' },
          ]}
        />
      </div>
    </div>
  );
}
