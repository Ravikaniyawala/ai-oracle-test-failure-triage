#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Local Oracle Experiment Runner
# Feeds Playwright JSON fixtures directly to the oracle and prints results.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-... ./scripts/run-local-experiment.sh
#
# Output: per-fixture verdict + category table printed to stdout.
#         oracle-verdict.json and oracle-decision-summary.md written per run.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Ensure node/npm are on PATH (nvm, homebrew, or system) ───────────────────
for _node_candidate in \
    "$HOME/.nvm/versions/node/v22.12.0/bin" \
    "$HOME/.nvm/versions/node/v21.6.2/bin" \
    "$HOME/.nvm/versions/node/v20.20.0/bin" \
    "/usr/local/bin" \
    "/opt/homebrew/bin"; do
  if [ -x "$_node_candidate/node" ] && "$_node_candidate/node" --version &>/dev/null 2>&1; then
    export PATH="$_node_candidate:$PATH"
    break
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORACLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_DIR="$ORACLE_DIR/tests/fixtures/experiment"
# PID suffix prevents DB collisions when multiple experiment runs execute concurrently.
# Callers may override via ORACLE_STATE_DB_PATH to reuse an existing DB.
DB_PATH="${ORACLE_STATE_DB_PATH:-/tmp/oracle-local-experiment-$$.db}"
# Verdict output path — kept per-invocation to avoid cross-run clobber.
VERDICT_PATH="${ORACLE_VERDICT_PATH:-$ORACLE_DIR/oracle-verdict-$$.json}"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "❌  ANTHROPIC_API_KEY is not set"
  exit 1
fi

# ── Fixture definitions: file | human label ───────────────────────────────────
declare -a FIXTURES=(
  "pw-flaky.json|FLAKY"
  "pw-regression.json|REGRESSION"
  "pw-new-bug.json|NEW_BUG"
  "pw-env-issue.json|ENV_ISSUE"
  "pw-ambiguous.json|REGRESSION_or_NEW_BUG"
)

# ── Header ────────────────────────────────────────────────────────────────────
printf "\n%-30s %-22s %-22s %-12s %s\n" "Fixture" "Human label" "Oracle label" "Confidence" "Match?"
printf "%-30s %-22s %-22s %-12s %s\n" "──────────────────────────────" "──────────────────────" "──────────────────────" "────────────" "──────"

# ── Run each fixture ──────────────────────────────────────────────────────────
for entry in "${FIXTURES[@]}"; do
  FILE="${entry%%|*}"
  HUMAN_LABEL="${entry##*|}"
  FIXTURE_PATH="$FIXTURE_DIR/$FILE"

  # Run oracle — suppress noisy logs, keep errors visible
  PLAYWRIGHT_REPORT_PATH="$FIXTURE_PATH" \
  ORACLE_STATE_DB_PATH="$DB_PATH" \
  ORACLE_VERDICT_PATH="$VERDICT_PATH" \
  REPORT_FORMAT="PLAYWRIGHT_JSON" \
  DRY_RUN="true" \
  CI_PIPELINE_ID="local-experiment-$(date +%s)" \
    npm run --silent triage 2>&1 | grep -v '^\[oracle\]\|^\[history\]\|DeprecationWarning\|Use `node\|punycode' >&2 || true

  # Parse verdict file
  VERDICT_FILE="$VERDICT_PATH"
  if [ ! -f "$VERDICT_FILE" ]; then
    printf "%-30s %-22s %-22s %-12s %s\n" "$FILE" "$HUMAN_LABEL" "ERROR (no verdict)" "—" "❌"
    continue
  fi

  # Extract first failure category + confidence from verdict
  ORACLE_CATEGORY=$(node -e "
    const v = JSON.parse(require('fs').readFileSync('$VERDICT_FILE','utf8'));
    const f = (v.failures || [])[0];
    console.log(f ? f.category : v.verdict === 'CLEAR' ? 'CLEAR' : 'UNKNOWN');
  " 2>/dev/null || echo "UNKNOWN")

  ORACLE_CONFIDENCE=$(node -e "
    const v = JSON.parse(require('fs').readFileSync('$VERDICT_FILE','utf8'));
    const f = (v.failures || [])[0];
    console.log(f ? Math.round(f.confidence * 100) + '%' : '—');
  " 2>/dev/null || echo "—")

  # Determine match (ambiguous fixture is exempt)
  if [[ "$HUMAN_LABEL" == *"_or_"* ]]; then
    MATCH="⚠️  ambiguous"
  elif [ "$ORACLE_CATEGORY" = "$HUMAN_LABEL" ]; then
    MATCH="✅"
  else
    MATCH="❌  (expected $HUMAN_LABEL)"
  fi

  printf "%-30s %-22s %-22s %-12s %s\n" "$FILE" "$HUMAN_LABEL" "$ORACLE_CATEGORY" "$ORACLE_CONFIDENCE" "$MATCH"
done

printf "\nDB written to: %s\n" "$DB_PATH"
printf "Verdict file:  %s\n" "$VERDICT_PATH"
printf "To inspect: sqlite3 %s \"SELECT test_name, category, confidence FROM failure_verdicts ORDER BY created_at DESC;\"\n\n" "$DB_PATH"
