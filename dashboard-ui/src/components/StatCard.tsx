interface Props {
  label:    string;
  value:    string | number;
  sub?:     string;
  accent?:  string;
}

export default function StatCard({ label, value, sub, accent }: Props) {
  return (
    <div style={{
      background:   'var(--color-surface)',
      border:       '1px solid var(--color-border)',
      borderRadius: 8,
      padding:      '16px 20px',
      minWidth:     140,
    }}>
      <div style={{ color: 'var(--color-muted)', fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: accent ?? 'var(--color-text)', lineHeight: 1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ color: 'var(--color-muted)', fontSize: 12, marginTop: 6 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
