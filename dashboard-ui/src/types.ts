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

/** One row in the recent runs table — includes per-run action stats. */
export interface RecentRunRow {
  id:             number;
  timestamp:      string;
  pipeline_id:    string;
  verdict:        string;
  total_failures: number;
  jiras_created:  number;
  suppressions:   number;
  actions_taken:  number;
}

/** Per-verdict action count for the Actions tab summary. */
export interface ActionVerdictSummaryRow {
  verdict: string;
  count:   number;
}

/** Aggregated overview stats. */
export interface OverviewStats {
  totalRuns:         number;
  clearRate:         number;
  failuresTriaged:   number;
  jirasCreated:      number;
  suppressionsSaved: number;
  categoryBreakdown: Record<string, number>;
}
