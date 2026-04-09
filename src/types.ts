export enum TriageCategory {
  FLAKY      = 'FLAKY',
  REGRESSION = 'REGRESSION',
  ENV_ISSUE  = 'ENV_ISSUE',
  NEW_BUG    = 'NEW_BUG',
}

export enum ReportFormat {
  PLAYWRIGHT_JSON = 'PLAYWRIGHT_JSON',
  PLAYWRIGHT_API  = 'PLAYWRIGHT_API',
  JUNIT_XML       = 'JUNIT_XML',
  PYTEST_JSON     = 'PYTEST_JSON',
  UNKNOWN         = 'UNKNOWN',
}

export interface PlaywrightFailure {
  testName:     string;
  errorMessage: string;
  errorHash:    string;
  file:         string;
  duration:     number;
  retries:      number;
}

export interface ParseResult {
  failures:       PlaywrightFailure[];
  detectedFormat: ReportFormat;
  totalTests:     number;
  totalFailures:  number;
}

export interface TriageResult extends PlaywrightFailure {
  category:     TriageCategory;
  confidence:   number;
  reasoning:    string;
  suggestedFix: string;
}

export interface RunSummary {
  [TriageCategory.FLAKY]:      number;
  [TriageCategory.REGRESSION]: number;
  [TriageCategory.ENV_ISSUE]:  number;
  [TriageCategory.NEW_BUG]:    number;
}

export interface TriageApiResponse {
  results: Array<{
    testName:      string;
    category:      TriageCategory;
    confidence:    number;
    reasoning:     string;
    suggested_fix: string;
  }>;
}

// ── Policy / orchestration types ─────────────────────────────────────────────

export type ActionType =
  | 'create_jira'
  | 'notify_slack'
  | 'quarantine_test'
  | 'retry_test'
  | 'request_human_review';

export type ActionScope     = 'failure' | 'cluster' | 'run';
export type DecisionVerdict = 'approved' | 'rejected' | 'deferred' | 'held';

export interface ActionProposal {
  type:        ActionType;
  scope:       ActionScope;
  scopeId:     string;
  failureId:   number | null;
  clusterKey:  string | null;
  runId:       number;
  pipelineId:  string;
  source:      'policy' | 'agent';
  fingerprint: string;
}

export interface Decision {
  proposal:   ActionProposal;
  verdict:    DecisionVerdict;
  confidence: number;
  reason:     string;
}

export interface ActionExecution {
  ok:        boolean;
  detail:    string;
  timestamp: string;
}

export interface JiraCreated {
  testName: string;
  category: TriageCategory;
  key:      string;
}

// ── History / explainability types ───────────────────────────────────────────

/**
 * A single decision entry collected during a triage run.
 * Used to build oracle-decision-summary.md and Slack highlights.
 */
export interface DecisionEntry {
  actionType:  string;
  verdict:     string;
  reason:      string;
  /** Test name for failure-scoped actions; undefined for run-scoped actions. */
  testName?:   string;
  /** Pre-formatted explanation line from explainDecision(). */
  explanation: string;
}

/**
 * Historical signal for a failure pattern (testName + errorHash).
 * Used in Slice 3.1 for explainability logging and verdict output (read-only).
 * Used in Slice 3.2 to influence a small set of decisions explicitly:
 *   - jiraDuplicateCount / jiraCreatedCount → may suppress create_jira
 *   - retryPassedCount / retryFailedCount   → may override retry_test verdict
 */
export interface PatternStats {
  /** Total action rows recorded for this testName:errorHash pair.
   *  Counts every action (create_jira, retry_test, etc.) not unique pipeline runs. */
  actionCount:        number;
  /** create_jira actions that executed successfully (execution_ok = 1). */
  jiraCreatedCount:   number;
  /** Distinct feedback rows marked jira_closed_duplicate for this pattern,
   *  matched by test_name+error_hash OR by action_fingerprint of related actions. */
  jiraDuplicateCount: number;
  /** feedback rows where feedback_type = retry_passed. */
  retryPassedCount:   number;
  /** feedback rows where feedback_type = retry_failed. */
  retryFailedCount:   number;
}

// ── Feedback types ────────────────────────────────────────────────────────────

export type FeedbackType =
  | 'jira_closed_duplicate'
  | 'jira_closed_confirmed'
  | 'classification_corrected'
  | 'action_overridden'
  | 'retry_passed'
  | 'retry_failed';

export interface FeedbackEntry {
  feedbackType:       FeedbackType;
  pipelineId?:        string;
  testName?:          string;
  errorHash?:         string;
  actionFingerprint?: string;
  oldValue?:          string;
  newValue?:          string;
  notes?:             string;
  createdAt:          string;
}

// ── PR / change context types ─────────────────────────────────────────────────

/**
 * A Jira issue linked in the PR description (e.g. "Fixes QA-123").
 * Populated from ORACLE_PR_CONTEXT_PATH — never fetched live.
 */
export interface LinkedJira {
  key:        string;
  title?:     string;
  issueType?: string;
  team?:      string;
}

/**
 * Lightweight change context read from ORACLE_PR_CONTEXT_PATH.
 * All fields except pipelineId and filesChanged are optional because
 * not every CI environment exposes PR metadata.
 */
export interface PrContext {
  pipelineId:   string;
  prNumber?:    number;
  title?:       string;
  author?:      string;
  baseBranch?:  string;
  headBranch?:  string;
  filesChanged: string[];
  linkedJira:   LinkedJira[];
}

/**
 * Read-only relevance signal computed per failure from PrContext.
 * Never influences decisions — used for logging and summary output only.
 *
 * high    — direct file overlap or 2+ keyword matches with changed files
 * medium  — 1 keyword match
 * low     — no overlap detected
 * unknown — no PR context available
 */
export interface PrRelevance {
  level:   'high' | 'medium' | 'low' | 'unknown';
  reasons: string[];
}

// ── Dashboard query result types ──────────────────────────────────────────────

/** One data point in a runs-by-verdict time series. */
export interface RunVerdictTrendRow {
  /** Date bucket in YYYY-MM-DD format. */
  day:     string;
  /** 'CLEAR' or 'BLOCKED'. */
  verdict: string;
  count:   number;
}

/** One data point in a failures-by-category time series. */
export interface FailureCategoryTrendRow {
  day:      string;
  /** One of the TriageCategory enum values. */
  category: string;
  count:    number;
}

/** One data point in an actions-by-type time series. */
export interface ActionTypeTrendRow {
  day:         string;
  action_type: string;
  /** 'approved' | 'rejected' | 'held' | 'deferred'. */
  verdict:     string;
  count:       number;
}

/** One row in a most-frequently-failing tests report. */
export interface RecurringFailureRow {
  test_name:   string;
  error_hash:  string;
  occurrences: number;
  /** ISO 8601 timestamp of the most recent occurrence. */
  last_seen:   string;
}

/** One row in a history-based suppression breakdown. */
export interface SuppressionSummaryRow {
  /** e.g. 'history:jira_already_created', 'history:duplicate_pattern'. */
  decision_reason: string;
  count:           number;
}

/** Aggregated overview stats for the /api/v1/overview endpoint. */
export interface OverviewStats {
  totalRuns:          number;
  clearRate:          number;   // 0–1
  failuresTriaged:    number;
  jirasCreated:       number;
  suppressionsSaved:  number;
  categoryBreakdown:  Record<string, number>;
}

/** Server metadata returned by /healthz. */
export interface DashboardMeta {
  ok:     boolean;
  uptime: number;
  db:     'connected' | 'error';
}

// ── Agent proposal types ──────────────────────────────────────────────────────

// Lifecycle status of a row in agent_proposals table.
export type AgentProposalStatus = 'received' | 'approved' | 'held' | 'rejected' | 'executed';

// Verdict returned by decideAgentProposal().
// Uses 'held' (not 'deferred') because these require explicit operator action.
export type AgentVerdict = 'approved' | 'held' | 'rejected';

// Validated internal form of an incoming agent proposal.
export interface AgentProposal {
  sourceAgent:  string;
  proposalType: string; // validated/handled in decideAgentProposal
  pipelineId:   string;
  testName:     string;
  errorHash:    string;
  confidence:   number;
  reasoning:    string;
  payload:      Record<string, unknown>;
}

// Result of running an agent proposal through the decision layer.
export interface AgentDecision {
  proposal:    AgentProposal;
  verdict:     AgentVerdict;
  reason:      string;
  fingerprint: string;
}
