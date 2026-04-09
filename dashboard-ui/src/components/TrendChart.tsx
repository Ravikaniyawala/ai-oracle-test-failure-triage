import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';

export interface TrendSeries {
  key:   string;
  color: string;
  label?: string;
}

interface Props {
  data:     Record<string, unknown>[];
  xKey:     string;
  series:   TrendSeries[];
  height?:  number;
  stacked?: boolean;
}

export default function TrendChart({ data, xKey, series, height = 240, stacked = false }: Props) {
  if (data.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-muted)', fontSize: 13 }}>
        No data for selected range
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey={xKey} tick={{ fill: 'var(--color-muted)', fontSize: 11 }} />
        <YAxis tick={{ fill: 'var(--color-muted)', fontSize: 11 }} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: 'var(--color-text)' }}
          itemStyle={{ color: 'var(--color-muted)' }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map(s => (
          <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={s.color} stackId={stacked ? 'stack' : undefined} radius={stacked ? undefined : [2, 2, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
