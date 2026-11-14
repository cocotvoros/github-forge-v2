// shapes.ts — the GitHub JSON shapes github-forge-v2 answers with, shared by the REST surface and
// the MCP tools so an object created on one surface reads back identically on the other.

import { Forge, VIEWER, type CommentRec, type IssueRec, type PullRec, type RepoRec } from './store.ts';

export function userShape(): Record<string, unknown> {
  return {
    login: VIEWER.login, id: VIEWER.id, type: VIEWER.type, name: VIEWER.name, email: VIEWER.email,
    avatar_url: `https://forge.invalid/avatars/${VIEWER.id}`,
    html_url: `https://forge.invalid/${VIEWER.login}`,
    url: `https://forge.invalid/api/v3/users/${VIEWER.login}`,
    site_admin: false,
  };
}

export function repoShape(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userShape(),
    private: repo.isPrivate,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: forge.isoOf(repo.seq),
    updated_at: forge.nowIso(),
    pushed_at: forge.nowIso(),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    allow_forking: true,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelShape(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

export function issueShape(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userShape(),
    labels: issue.labels.map((name) => labelShape(repo, name)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.seq),
    updated_at: forge.isoOf(issue.seq),
    closed_at: null,
    author_association: 'OWNER',
    body: issue.body,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels`,
    comments_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
  };
}

export function commentShape(forge: Forge, repo: RepoRec, issue: IssueRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userShape(),
    created_at: forge.isoOf(comment.seq),
    updated_at: forge.isoOf(comment.seq),
    author_association: 'OWNER',
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullShape(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.baseShaAtCreation;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreation;
  return {
    id: pull.id,
    node_id: `P_${repo.id}_${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userShape(),
    body: pull.body,
    created_at: forge.isoOf(pull.seq),
    updated_at: forge.isoOf(pull.seq),
    closed_at: pull.state === 'closed' ? forge.isoOf(pull.mergedSeq || pull.seq) : null,
    merged_at: pull.merged ? forge.isoOf(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userShape(),
      repo: repoShape(forge, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userShape(),
      repo: repoShape(forge, repo),
    },
    _links: { self: { href: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` } },
    author_association: 'OWNER',
    draft: false,
    merged: pull.merged,
    mergeable: pull.merged ? null : !forge.analyzeMerge(repo, pull).conflict,
    mergeable_state: pull.merged ? 'unknown' : forge.analyzeMerge(repo, pull).conflict ? 'dirty' : 'clean',
    merged_by: pull.merged ? userShape() : null,
    comments: 0,
    review_comments: 0,
    maintained_can_modify: false,
    commits: 1,
    additions: forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0),
    deletions: forge.pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0),
    changed_files: forge.pullFiles(repo, pull).length,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}
