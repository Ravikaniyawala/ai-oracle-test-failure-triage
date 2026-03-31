// PR/MR comment poster — supports GitHub and GitLab.
// Platform is auto-detected from environment variables.
// The comment is replaced on each push (not duplicated) using a hidden marker.

const MARKER = '<!-- oracle-triage -->';

export async function postPrComment(markdown: string): Promise<void> {
  const body = MARKER + '\n' + markdown;

  if (process.env['GITHUB_ACTIONS'] === 'true') {
    await postGitHubComment(body);
  } else if (process.env['GITLAB_CI'] === 'true') {
    await postGitLabComment(body);
  } else {
    console.log('[oracle] pr-commenter: not on GitHub Actions or GitLab CI, skipping');
  }
}

// ── GitHub ────────────────────────────────────────────────────────────────────

async function postGitHubComment(body: string): Promise<void> {
  const token  = process.env['GITHUB_TOKEN'];
  const repo   = process.env['GITHUB_REPOSITORY'];   // owner/repo
  const branch = process.env['GITHUB_REF_NAME'];

  if (!token) {
    console.warn('[oracle] pr-commenter: GITHUB_TOKEN not set, skipping');
    return;
  }
  if (!repo || !branch) {
    console.warn('[oracle] pr-commenter: GITHUB_REPOSITORY or GITHUB_REF_NAME not set, skipping');
    return;
  }

  const [owner] = repo.split('/');

  // Find open PR for this branch
  const prsRes = await fetch(
    `https://api.github.com/repos/${repo}/pulls?head=${owner}:${branch}&state=open`,
    { headers: githubHeaders(token) },
  );
  const prs = await prsRes.json() as Array<{ number: number }>;
  if (!Array.isArray(prs) || prs.length === 0) {
    console.log(`[oracle] pr-commenter: no open PR found for branch '${branch}', skipping`);
    return;
  }
  const prNumber = prs[0]!.number;

  // Find and delete previous oracle comment to avoid duplicates
  const commentsRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
    { headers: githubHeaders(token) },
  );
  const comments = await commentsRes.json() as Array<{ id: number; body: string }>;
  for (const c of comments) {
    if (c.body.startsWith(MARKER)) {
      await fetch(
        `https://api.github.com/repos/${repo}/issues/comments/${c.id}`,
        { method: 'DELETE', headers: githubHeaders(token) },
      );
      console.log(`[oracle] pr-commenter: replaced previous comment on PR #${prNumber}`);
      break;
    }
  }

  // Post new comment
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
    {
      method:  'POST',
      headers: githubHeaders(token),
      body:    JSON.stringify({ body }),
    },
  );
  if (res.ok) {
    console.log(`[oracle] pr-commenter: posted comment on GitHub PR #${prNumber}`);
  } else {
    console.warn('[oracle] pr-commenter: failed to post GitHub comment —', res.status, await res.text());
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    'Authorization':        `Bearer ${token}`,
    'Accept':               'application/vnd.github+json',
    'Content-Type':         'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ── GitLab ────────────────────────────────────────────────────────────────────

async function postGitLabComment(body: string): Promise<void> {
  const token     = process.env['GITLAB_TOKEN'];
  const projectId = process.env['CI_PROJECT_ID'];
  const apiBase   = process.env['CI_API_V4_URL'] ?? 'https://gitlab.com/api/v4';

  if (!token) {
    console.warn('[oracle] pr-commenter: GITLAB_TOKEN not set, skipping');
    return;
  }
  if (!projectId) {
    console.warn('[oracle] pr-commenter: CI_PROJECT_ID not set, skipping');
    return;
  }

  // CI_MERGE_REQUEST_IID is set on detached MR pipelines.
  // Fall back to searching by branch for push pipelines.
  let mrIid = process.env['CI_MERGE_REQUEST_IID'];
  if (!mrIid) {
    const branch = process.env['CI_COMMIT_BRANCH'];
    if (!branch) {
      console.log('[oracle] pr-commenter: CI_MERGE_REQUEST_IID and CI_COMMIT_BRANCH not set, skipping');
      return;
    }
    const mrsRes = await fetch(
      `${apiBase}/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`,
      { headers: gitlabHeaders(token) },
    );
    const mrs = await mrsRes.json() as Array<{ iid: number }>;
    if (!Array.isArray(mrs) || mrs.length === 0) {
      console.log(`[oracle] pr-commenter: no open MR found for branch '${branch}', skipping`);
      return;
    }
    mrIid = String(mrs[0]!.iid);
  }

  // Find and delete previous oracle note to avoid duplicates
  const notesRes = await fetch(
    `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=100`,
    { headers: gitlabHeaders(token) },
  );
  const notes = await notesRes.json() as Array<{ id: number; body: string }>;
  for (const n of notes) {
    if (n.body.startsWith(MARKER)) {
      await fetch(
        `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/notes/${n.id}`,
        { method: 'DELETE', headers: gitlabHeaders(token) },
      );
      console.log(`[oracle] pr-commenter: replaced previous note on MR !${mrIid}`);
      break;
    }
  }

  // Post new note
  const res = await fetch(
    `${apiBase}/projects/${projectId}/merge_requests/${mrIid}/notes`,
    {
      method:  'POST',
      headers: gitlabHeaders(token),
      body:    JSON.stringify({ body }),
    },
  );
  if (res.ok) {
    console.log(`[oracle] pr-commenter: posted note on GitLab MR !${mrIid}`);
  } else {
    console.warn('[oracle] pr-commenter: failed to post GitLab note —', res.status, await res.text());
  }
}

function gitlabHeaders(token: string): Record<string, string> {
  return {
    'PRIVATE-TOKEN': token,
    'Content-Type':  'application/json',
  };
}
