import type {
  ActionTypeTrendRow,
  ActionVerdictSummaryRow,
  FailureCategoryTrendRow,
  OverviewStats,
  RecentRunRow,
  RecurringFailureRow,
  RunVerdictTrendRow,
  SuppressionSummaryRow,
} from './types';

function getRepoId(): string | null {
  // Path-based: /repos/{repoId}/...
  const m = window.location.pathname.match(/\/repos\/([^/]+)/);
  if (m?.[1]) return m[1];
  // Query-param fallback: ?repo={repoId}
  return new URLSearchParams(window.location.search).get('repo');
}

function buildBase(): string {
  const basePath = (import.meta.env['VITE_BASE_PATH'] as string | undefined)?.replace(/\/$/, '') ?? '';
  const repoId   = getRepoId();
  return repoId ? `${basePath}/api/repos/${repoId}` : `${basePath}/api/v1`;
}

interface DateRange {
  start?: string;
  end?:   string;
}

function buildUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
  const url = new URL(`${buildBase()}${path}`, window.location.origin);
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

export async function fetchManifest(): Promise<{ repo_display_name: string; repo_name: string } | null> {
  const repoId = getRepoId();
  if (!repoId) return null;
  const basePath = (import.meta.env['VITE_BASE_PATH'] as string | undefined)?.replace(/\/$/, '') ?? '';
  try {
    const res = await fetch(`${basePath}/api/repos/${repoId}/manifest`);
    if (!res.ok) return null;
    return res.json() as Promise<{ repo_display_name: string; repo_name: string }>;
  } catch {
    return null;
  }
}

export const api = {
  overview:            ()                           => get<OverviewStats>(buildUrl('/overview')),
  runsTrend:           (r: DateRange = {})          => get<RunVerdictTrendRow[]>(buildUrl('/runs/trend', r)),
  failuresTrend:       (r: DateRange = {})          => get<FailureCategoryTrendRow[]>(buildUrl('/failures/trend', r)),
  failuresTop:         (r: DateRange & { limit?: number } = {}) =>
                         get<RecurringFailureRow[]>(buildUrl('/failures/top', r)),
  actionsTrend:         (r: DateRange = {})                      => get<ActionTypeTrendRow[]>(buildUrl('/actions/trend', r)),
  actionsSuppression:   (r: DateRange = {})                      => get<SuppressionSummaryRow[]>(buildUrl('/actions/suppression', r)),
  actionsVerdictSummary: ()                                      => get<ActionVerdictSummaryRow[]>(buildUrl('/actions/verdict-summary')),
  recentRuns:           (limit = 10)                             => get<RecentRunRow[]>(buildUrl('/runs/recent', { limit })),
};
