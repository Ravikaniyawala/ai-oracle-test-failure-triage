/**
 * Stage 2 — Repo identity resolution.
 *
 * Priority:
 *   1. ORACLE_REPO_* env vars (explicit operator override)
 *   2. GitHub Actions built-in vars (GITHUB_REPOSITORY_ID, GITHUB_REPOSITORY)
 *   3. null — identity unavailable, snapshot export is skipped
 */

export interface RepoIdentity {
  /** Numeric repo ID or explicit override. Stable across renames. */
  repoId:          string;
  /** "owner/repo" format. */
  repoName:        string;
  /** Human-friendly label for dashboard UI. */
  repoDisplayName: string;
}

export function resolveRepoIdentity(): RepoIdentity | null {
  const repoId = process.env['ORACLE_REPO_ID'] ?? process.env['GITHUB_REPOSITORY_ID'] ?? null;
  if (!repoId) return null;

  const repoName        = process.env['ORACLE_REPO_NAME']         ?? process.env['GITHUB_REPOSITORY']    ?? repoId;
  const repoDisplayName = process.env['ORACLE_REPO_DISPLAY_NAME'] ??
    (repoName.includes('/') ? (repoName.split('/')[1] ?? repoName) : repoName);

  return { repoId, repoName, repoDisplayName };
}
