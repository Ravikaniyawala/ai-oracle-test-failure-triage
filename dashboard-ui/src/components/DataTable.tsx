import { useState } from 'react';

export interface Column<T> {
  key:      keyof T;
  header:   string;
  /**
   * Custom cell renderer. Note: `val` is typed as `T[keyof T]` (the union of
   * every field's type in T) rather than the type of this column's specific
   * key — TypeScript can't narrow on a runtime-selected key here without a
   * per-key generic, which would balloon the call sites. Cast inside the
   * render body when you need the precise type:
   *
   *   render: (val) => (val as 'CLEAR' | 'BLOCKED') === 'CLEAR' ? '✓' : '✗'
   */
  render?:  (val: T[keyof T], row: T) => React.ReactNode;
  width?:   string;
}

interface Props<T extends object> {
  columns: Column<T>[];
  rows:    T[];
  rowKey:  (row: T) => string;
}

/**
 * Comparator for cell values. Handles the four shapes that show up in
 * dashboard rows: string, number, boolean, Date, plus null/undefined.
 * Anything else falls through to a String() comparison so the table at
 * least sorts deterministically instead of throwing — but a future column
 * adding e.g. a tuple should add an explicit branch here.
 *
 * Direction is passed in (rather than relying on the call site to negate
 * the return value) so that "missing" values can be pinned to the END of
 * the visible list in BOTH ascending and descending sorts. If the call
 * site negated, missing-on-asc-tail would become missing-on-desc-head,
 * and a column with a few null cells would push real data off the top
 * row in descending order.
 *
 * Numeric handling: `NaN`, `±Infinity`, `null`, `undefined`, and Invalid
 * Date are treated as "missing". Returning `NaN` from a comparator gives
 * V8 unspecified order across Node versions, so we never let `a - b`
 * propagate NaN.
 *
 * Booleans sort `false` before `true` in ascending; descending reverses
 * to `true` before `false`. Missing booleans (which can't actually exist
 * via `typeof === 'boolean'` but might arrive as null cells in a
 * boolean column) stay at the end of both directions.
 */
function compareValues(a: unknown, b: unknown, direction: 'asc' | 'desc'): number {
  // Missing values are pinned to the end, regardless of sort direction.
  // This block returns BEFORE the direction flip so its sign is preserved
  // for both 'asc' and 'desc'.
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return  1;
  if (bMissing) return -1;

  // Compute the natural ascending comparison for non-missing values, then
  // flip exactly once at the end for descending.
  const cmp = compareDefined(a, b);
  return direction === 'asc' ? cmp : -cmp;
}

/**
 * Ascending-sense comparison for two non-missing values. Callers must
 * route null/undefined/NaN/±Infinity/Invalid-Date through `isMissing`
 * first — this helper assumes finite, defined inputs.
 */
function compareDefined(a: unknown, b: unknown): number {
  if (typeof a === 'number'  && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) {
    // getTime() on an Invalid Date is NaN; isMissing already routed those.
    return a.getTime() - b.getTime();
  }
  if (typeof a === 'string'  && typeof b === 'string')  return a < b ? -1 : a > b ? 1 : 0;

  // Mixed/unknown types — coerce to string. Lexicographic compare is the
  // last-resort fallback and may be wrong for booleans-vs-strings etc., but
  // never throws.
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function isMissing(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  // NaN and ±Infinity sort to the end so the row order is deterministic
  // regardless of where they appear in the input.
  if (typeof v === 'number' && !Number.isFinite(v)) return true;
  // Invalid Date (`new Date('not a date')`) — its getTime() is NaN.
  if (v instanceof Date && Number.isNaN(v.getTime())) return true;
  return false;
}

export default function DataTable<T extends object>({ columns, rows, rowKey }: Props<T>) {
  const [sortKey,  setSortKey]  = useState<keyof T | null>(null);
  const [sortDir,  setSortDir]  = useState<'asc' | 'desc'>('desc');

  function handleSort(key: keyof T) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  const sorted = sortKey
    ? [...rows].sort((a, b) => compareValues(a[sortKey], b[sortKey], sortDir))
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
