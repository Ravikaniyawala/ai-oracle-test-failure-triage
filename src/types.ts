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
