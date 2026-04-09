/** One data point in a runs-by-verdict time series. */
export interface RunVerdictTrendRow {
  day:     string;
  verdict: string;
  count:   number;
}

/** One data point in a failures-by-category time series. */
export interface FailureCategoryTrendRow {
  day:      string;
  category: string;
  count:    number;
}

/** One data point in an actions-by-type time series. */
export interface ActionTypeTrendRow {
  day:         string;
  action_type: string;
  verdict:     string;
  count:       number;
}

/** One row in a most-frequently-failing tests report. */
export interface RecurringFailureRow {
  test_name:   string;
  error_hash:  string;
  occurrences: number;
  last_seen:   string;
}

/** One row in a history-based suppression breakdown. */
export interface SuppressionSummaryRow {
  decision_reason: string;
  count:           number;
}

/** Aggregated overview stats. */
export interface OverviewStats {
  totalRuns:         number;
  clearRate:         number;
  totalFailures:     number;
  suppressionsSaved: number;
  categoryBreakdown: Record<string, number>;
}
