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

export type ActionType      = 'create_jira' | 'notify_slack' | 'quarantine_test';
export type ActionScope     = 'failure' | 'cluster' | 'run';
export type DecisionVerdict = 'approved' | 'rejected' | 'deferred';

export interface ActionProposal {
  type:        ActionType;
  scope:       ActionScope;
  scopeId:     string;
  failureId:   number | null;
  clusterKey:  string | null;
  runId:       number;
  pipelineId:  string;
  source:      'policy';
  fingerprint: string;
}

export interface Decision {
  proposal:   ActionProposal;
  verdict:    DecisionVerdict;
  confidence: number;
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
