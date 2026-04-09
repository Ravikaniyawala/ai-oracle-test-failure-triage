import { useState } from 'react';

export interface Column<T> {
  key:      keyof T;
  header:   string;
  render?:  (val: T[keyof T], row: T) => React.ReactNode;
  width?:   string;
}

interface Props<T extends Record<string, unknown>> {
  columns: Column<T>[];
  rows:    T[];
  rowKey:  (row: T) => string;
}

export default function DataTable<T extends Record<string, unknown>>({ columns, rows, rowKey }: Props<T>) {
  const [sortKey,  setSortKey]  = useState<keyof T | null>(null);
  const [sortDir,  setSortDir]  = useState<'asc' | 'desc'>('desc');

  function handleSort(key: keyof T) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  const sorted = sortKey
    ? [...rows].sort((a, b) => {
        const av = a[sortKey];
        const bv = b[sortKey];
        const cmp = av === bv ? 0 : av < bv ? -1 : 1;
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : rows;

  if (sorted.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-muted)', fontSize: 13 }}>No data</div>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th
                key={String(col.key)}
                onClick={() => handleSort(col.key)}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  color: 'var(--color-muted)',
                  borderBottom: '1px solid var(--color-border)',
                  cursor: 'pointer',
                  userSelect: 'none',
                  width: col.width,
                  whiteSpace: 'nowrap',
                }}
              >
                {col.header}
                {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => (
            <tr key={rowKey(row)} style={{ borderBottom: '1px solid var(--color-border)' }}>
              {columns.map(col => (
                <td key={String(col.key)} style={{ padding: '8px 12px', color: 'var(--color-text)' }}>
                  {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
