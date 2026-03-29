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
  createJira:   boolean;
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
    create_jira:   boolean;
  }>;
}
