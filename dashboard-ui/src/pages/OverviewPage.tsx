import { useEffect, useState } from 'react';
import { api } from '../api';
import type { OverviewStats, RecentRunRow, RunVerdictTrendRow } from '../types';
import StatCard from '../components/StatCard';
import TrendChart from '../components/TrendChart';

// ── Helpers ───────────────────────────────────────────────────────────────────

function pivotTrend(rows: RunVerdictTrendRow[]): Record<string, unknown>[] {
  const byDay = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day });
    byDay.get(r.day)![r.verdict] = r.count;
  }
  return [...byDay.values()].sort((a, b) => (a['day'] as string) < (b['day'] as string) ? -1 : 1);
}

function fmtTime(ts: string): string {
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return ts; }
}

function fmtRelative(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins   = Math.floor(diffMs / 60_000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Latest Run panel ──────────────────────────────────────────────────────────

function LatestRunPanel({ run }: { run: RecentRunRow }) {
  const isClear   = run.verdict === 'CLEAR';
  const verdictColor = isClear ? 'var(--color-clear)' : 'var(--color-blocked)';

  return (
    <div style={{
      background:   'var(--color-surface)',
      border:       `1px solid ${verdictColor}`,
      borderRadius: 8,
      padding:      '16px 20px',
      marginBottom: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <span style={{ fontSize: 11, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Latest Run
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
            <span style={{
              fontSize: 13, fontWeight: 700, color: verdictColor,
              background: `${verdictColor}22`, borderRadius: 4, padding: '2px 8px',
            }}>
              {run.verdict}
            </span>
            <span style={{ fontSize: 13, color: 'var(--color-text)', fontFamily: 'monospace' }}>
              {run.pipeline_id}
            </span>
            <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
              {fmtRelative(run.timestamp)} · {fmtTime(run.timestamp)}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          <Pill label="Failures"     value={run.total_failures} accent={run.total_failures > 0 ? 'var(--color-blocked)' : 'var(--color-muted)'} />
          <Pill label="Jiras Filed"  value={run.jiras_created}  accent="var(--color-accent)" />
          <Pill label="Suppressed"   value={run.suppressions}   accent="var(--color-muted)" />
          <Pill label="Actions"      value={run.actions_taken}  accent="var(--color-muted)" />
        </div>
      </div>
    </div>
  );
}

function Pill({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>{label}</div>
    </div>
  );
}

// ── Recent runs table ─────────────────────────────────────────────────────────

const VERDICT_BADGE: Record<string, string> = {
  CLEAR:   'var(--color-clear)',
  BLOCKED: 'var(--color-blocked)',
};

function RecentRunsTable({ runs }: { runs: RecentRunRow[] }) {
  if (runs.length === 0) {
    return <div style={{ padding: 16, color: 'var(--color-muted)', fontSize: 13 }}>No runs recorded yet.</div>;
  }

  const th: React.CSSProperties = {
    textAlign: 'left', padding: '7px 10px', color: 'var(--color-muted)',
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = {
    padding: '7px 10px', fontSize: 13, color: 'var(--color-text)',
    borderBottom: '1px solid var(--color-border)', whiteSpace: 'nowrap',
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Time</th>
            <th style={th}>Pipeline / Run</th>
            <th style={th}>Verdict</th>
            <th style={{ ...th, textAlign: 'right' }}>Failures</th>
            <th style={{ ...th, textAlign: 'right' }}>Jiras</th>
            <th style={{ ...th, textAlign: 'right' }}>Suppressed</th>
            <th style={{ ...th, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(r => {
            const color = VERDICT_BADGE[r.verdict] ?? 'var(--color-muted)';
            return (
              <tr key={r.id}>
                <td style={{ ...td, color: 'var(--color-muted)', fontSize: 12 }}>
                  <span title={fmtTime(r.timestamp)}>{fmtRelative(r.timestamp)}</span>
                </td>
                <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{r.pipeline_id}</td>
                <td style={td}>
                  <span style={{ color, fontWeight: 600, fontSize: 12 }}>{r.verdict}</span>
                </td>
                <td style={{ ...td, textAlign: 'right', color: r.total_failures > 0 ? 'var(--color-blocked)' : 'var(--color-muted)' }}>
                  {r.total_failures}
                </td>
                <td style={{ ...td, textAlign: 'right', color: r.jiras_created > 0 ? 'var(--color-accent)' : 'var(--color-muted)' }}>
                  {r.jiras_created}
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--color-muted)' }}>
                  {r.suppressions}
                </td>
                <td style={{ ...td, textAlign: 'right', color: 'var(--color-muted)' }}>
                  {r.actions_taken}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const [stats,      setStats]      = useState<OverviewStats | null>(null);
  const [trend,      setTrend]      = useState<Record<string, unknown>[]>([]);
  const [recentRuns, setRecentRuns] = useState<RecentRunRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.overview(), api.runsTrend(), api.recentRuns(10)])
      .then(([s, t, r]) => {
        setStats(s);
        setTrend(pivotTrend(t));
        setRecentRuns(r);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: 'var(--color-muted)', padding: 24 }}>Loading…</div>;
  if (error)   return <div style={{ color: 'var(--color-blocked)', padding: 24 }}>Error: {error}</div>;
  if (!stats)  return null;

  const clearPct     = `${(stats.clearRate * 100).toFixed(1)}%`;
  const minutesSaved = stats.jirasCreated * 15 + stats.suppressionsSaved * 5;
  const timeSaved    = minutesSaved >= 60
    ? `~${(minutesSaved / 60).toFixed(1)} hrs`
    : `~${minutesSaved} min`;

  const latestRun = recentRuns[0] ?? null;

  return (
    <div>
      {/* ── Stat cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))', gap: 14, marginBottom: 24 }}>
        <StatCard label="Total Runs"         value={stats.totalRuns}         />
        <StatCard label="Clear Rate"         value={clearPct}                accent="var(--color-clear)" />
        <StatCard label="Failures Triaged"   value={stats.failuresTriaged}   accent={stats.failuresTriaged > 0 ? 'var(--color-blocked)' : undefined} sub="classified by Oracle" />
        <StatCard label="Jiras Created"      value={stats.jirasCreated}      accent="var(--color-accent)" sub="auto-filed" />
        <StatCard label="Suppressions Saved" value={stats.suppressionsSaved} sub="duplicate actions blocked" />
        <StatCard label="Est. Time Saved"    value={timeSaved}               accent="var(--color-clear)" sub="15 min/Jira · 5 min/suppression" />
      </div>

      {/* ── Latest run ── */}
      {latestRun && <LatestRunPanel run={latestRun} />}

      {/* ── Last 10 runs ── */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '16px 20px', marginBottom: 24 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Last 10 Runs
        </h2>
        <RecentRunsTable runs={recentRuns} />
      </div>

      {/* ── Run trend chart ── */}
      <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '16px 20px' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 14, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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
