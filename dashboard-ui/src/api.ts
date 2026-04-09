import type {
  ActionTypeTrendRow,
  FailureCategoryTrendRow,
  OverviewStats,
  RecurringFailureRow,
  RunVerdictTrendRow,
  SuppressionSummaryRow,
} from './types';

const BASE = (import.meta.env['VITE_BASE_PATH']?.replace(/\/$/, '') ?? '') + '/api/v1';

interface DateRange {
  start?: string;
  end?:   string;
}

function buildUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  overview:            ()                           => get<OverviewStats>(buildUrl('/overview')),
  runsTrend:           (r: DateRange = {})          => get<RunVerdictTrendRow[]>(buildUrl('/runs/trend', r)),
  failuresTrend:       (r: DateRange = {})          => get<FailureCategoryTrendRow[]>(buildUrl('/failures/trend', r)),
  failuresTop:         (r: DateRange & { limit?: number } = {}) =>
                         get<RecurringFailureRow[]>(buildUrl('/failures/top', r)),
  actionsTrend:        (r: DateRange = {})          => get<ActionTypeTrendRow[]>(buildUrl('/actions/trend', r)),
  actionsSuppression:  (r: DateRange = {})          => get<SuppressionSummaryRow[]>(buildUrl('/actions/suppression', r)),
};
