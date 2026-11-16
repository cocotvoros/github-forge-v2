// app.ts — github-forge-v2's HTTP surface: git smart HTTP at /{owner}/{repo}.git, REST v3 under
// /api/v3, GraphQL v4 at /api/graphql and MCP at /mcp, all over one in-memory Forge store.
// Discipline that the protocol checks own: every REST reply is application/json (never HTML) and
// carries a non-empty X-GitHub-Request-Id; errors are JSON {message}; a missing token is 401; a
// repository under another owner is 404, never 403; malformed JSON is 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { commentShape, issueShape, labelShape, pullShape, repoShape, userShape } from './shapes.ts';
import { advertise, fetch as gitFetch, lsRefs, receivePack } from './gitproto.ts';
import { parseCommit, parseTree } from './gitobj.ts';
import { GraphQLExecutor } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const forge = new Forge();
let requestSeq = 0;

interface Reply { status: number; body: unknown; headers?: Record<string, string>; raw?: Buffer }

function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}
function notFound(message = 'Not Found'): Reply { return jsonReply(404, { message }); }
function unprocessable(message: string): Reply { return jsonReply(422, { message }); }

function sendJson(res: ServerResponse, reply: Reply): void {
  if (reply.status === 204) {
    res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) });
    res.end();
    return;
  }
  if (reply.raw) {
    res.writeHead(reply.status, {
      'content-type': JSON_TYPE,
      'content-length': reply.raw.length,
      'x-github-request-id': nextRequestId(),
      ...(reply.headers ?? {}),
    });
    res.end(reply.raw);
    return;
  }
  const text = `${JSON.stringify(reply.body)}\n`;
  res.writeHead(reply.status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...(reply.headers ?? {}),
  });
  res.end(text);
}

// ------------------------------------------------------------------ serialized-reply cache

// The hottest reads (one repository, one issue, one pull) are pure functions of fingerprinted
// state, so their serialized bytes are memoized and repeats skip shaping and stringifying.
// A fingerprint mismatch — any mutation of the underlying records — rebuilds the reply.
interface CachedReply { fp: string; raw: Buffer }
const replyCache = new Map<string, CachedReply>();

function cachedJson(key: string, fp: string, make: () => Reply): Reply {
  const hit = replyCache.get(key);
  if (hit && hit.fp === fp) return { status: 200, body: null, raw: hit.raw };
  const reply = make();
  if (reply.status === 200) {
    const raw = Buffer.from(`${JSON.stringify(reply.body)}\n`, 'utf8');
    replyCache.set(key, { fp, raw });
    return { ...reply, raw };
  }
  return reply;
}

function refsFingerprint(repo: RepoRec): string {
  let fp = '';
  for (const [ref, oid] of repo.refs) fp += `${ref}=${oid};`;
  return fp;
}

function repoFingerprint(repo: RepoRec): string {
  let open = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') open += 1;
  // forge.nowIso() is the global sequence clock the shapes stamp replies with; including it keeps
  // a cached reply from ever outliving the timestamps it was serialized with.
  return [forge.nowIso(), repo.seq, repo.description, repo.isPrivate, repo.defaultBranch, repo.objects.size,
    repo.issues.size, open, repo.pulls.size, refsFingerprint(repo)].join('|');
}

function issueFingerprint(repo: RepoRec, issue: IssueRec): string {
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name);
    return `${name}:${label?.color ?? ''}:${label?.description ?? ''}`;
  }).join(',');
  return [forge.nowIso(), issue.state, issue.title, issue.body, issue.seq, issue.comments.length, labels].join('|');
}

function pullFingerprint(repo: RepoRec, pull: PullRec): string {
  return [forge.nowIso(), pull.state, pull.title, pull.body, pull.seq, pull.merged, pull.mergedSeq,
    pull.mergeCommitSha ?? '', pull.headRef, pull.baseRef, refsFingerprint(repo)].join('|');
}

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-v2-${requestSeq}`;
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

function pageParams(query: Record<string, string>): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.per_page ?? '30') || 30));
  const page = Math.max(1, Number(query.page ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: Record<string, string>): T[] {
  const { page, perPage } = pageParams(query);
  return items.slice((page - 1) * perPage, page * perPage);
}

/** A Link header with rel="next" while more pages remain (absolute, on the request's own origin). */
function linkHeader(req: IncomingMessage, path: string, query: Record<string, string>, total: number): Record<string, string> {
  const { page, perPage } = pageParams(query);
  if (page * perPage >= total) return {};
  const host = req.headers.host ?? '127.0.0.1';
  const params = new URLSearchParams({ ...query, page: String(page + 1), per_page: String(perPage) });
  return { link: `<http://${host}${path}?${params.toString()}>; rel="next"` };
}

// ------------------------------------------------------------------ contents helpers

interface ContentResult { reply: Reply }

function contentsGet(repo: RepoRec, path: string, ref: string | undefined): Reply {
  const tip = forge.resolveRef(repo, ref);
  if (!tip) return path === '' ? jsonReply(200, []) : notFound();
  const files = forge.filesAtCommit(repo, tip);
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean !== '' && files.has(clean)) {
    const entry = files.get(clean) as { oid: string; data: Buffer };
    const name = clean.split('/').pop() as string;
    return jsonReply(200, {
      name, path: clean, sha: entry.oid, size: entry.data.length, type: 'file', encoding: 'base64',
      content: entry.data.toString('base64'),
      url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/contents/${clean}`,
      html_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/main/${clean}`,
      git_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
      download_url: `https://forge.invalid/${repo.owner}/${repo.name}/raw/main/${clean}`,
    });
  }
  // Directory listing: immediate children of `clean` (or of the root), derived from the file map;
  // a directory child's sha is the tree oid found by navigating the commit's tree.
  const prefix = clean === '' ? '' : `${clean}/`;
  const commit = repo.objects.get(tip);
  const rootTree = commit?.type === 'commit' ? parseCommit(commit.data).tree : '';
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [filePath, entry] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const remainder = filePath.slice(prefix.length);
    if (remainder === '') continue;
    const slash = remainder.indexOf('/');
    if (slash < 0) {
      children.set(remainder, { type: 'file', oid: entry.oid, size: entry.data.length });
    } else {
      const dirName = remainder.slice(0, slash);
      if (!children.has(dirName)) {
        const dirPath = `${prefix}${dirName}`;
        children.set(dirName, { type: 'dir', oid: treeOidAt(repo, rootTree, dirPath.split('/')) ?? entry.oid, size: 0 });
      }
    }
  }
  if (clean !== '' && children.size === 0) return notFound();
  const listing = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({
      name, path: `${prefix}${name}`, sha: entry.oid, size: entry.size, type: entry.type,
      url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
      html_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/main/${prefix}${name}`,
      git_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
      download_url: entry.type === 'file' ? `https://forge.invalid/${repo.owner}/${repo.name}/raw/main/${prefix}${name}` : null,
    }));
  return jsonReply(200, listing);
}

/** The tree oid at a directory path inside a root tree, or null when the path is not a directory. */
function treeOidAt(repo: RepoRec, rootTree: string, segments: string[]): string | null {
  let current = rootTree;
  for (const segment of segments) {
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// ------------------------------------------------------------------ REST routing

function restRoute(req: IncomingMessage, url: URL, rawBody: Buffer): Reply {
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const query = queryOf(url);
  const segments = path.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
  // segments[0..1] are 'api','v3' for every REST call.
  const rest = segments.slice(2);

  const needsJson = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  let body: Record<string, unknown> = {};
  if (needsJson && rawBody.length > 0) {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) return jsonReply(400, { message: 'Problems parsing JSON' });
    body = parsed.value;
  }

  if (rest.length === 0) {
    if (method === 'GET') {
      return jsonReply(200, {
        current_user_url: '/api/v3/user',
        current_user_repositories_url: '/api/v3/user/repos{/type}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' });
    }
    return notFound();
  }
  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    return jsonReply(200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      github_services_sha: 'forge-v2',
      hooks: [], git: [], packages: [], pages: [],
    });
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') return jsonReply(200, userShape());
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const all = forge.listRepos();
      const items = paginate(all, query).map((repo) => repoShape(forge, repo));
      return jsonReply(200, items, linkHeader(req, '/api/v3/user/repos', query, all.length));
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('Repository creation failed: name is required');
      if (forge.getRepo(VIEWER.login, name)) return unprocessable(`Repository creation failed: name already exists on this account`);
      const repo = forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (body.auto_init === true) {
        forge.commitOnBranch(repo, repo.defaultBranch, (files) => {
          files.set('README.md', Buffer.from(`# ${name}\n`, 'utf8'));
        }, 'Initial commit');
      }
      return jsonReply(201, repoShape(forge, repo));
    }
  }
  if (rest[0] !== 'repos' || rest.length < 3) return notFound();
  const owner = rest[1] as string;
  const repoName = rest[2] as string;
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return notFound();
  const tail = rest.slice(3);
  return repoRoute(req, repo, method, tail, query, body, url);
}

function repoRoute(
  req: IncomingMessage, repo: RepoRec, method: string,
  tail: string[], query: Record<string, string>, body: Record<string, unknown>, url: URL,
): Reply {
  void req;
  if (tail.length === 0) {
    if (method === 'GET') {
      return cachedJson(`repo:${repo.owner}/${repo.name}`, repoFingerprint(repo),
        () => jsonReply(200, repoShape(forge, repo)));
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = body.name;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      return jsonReply(200, repoShape(forge, repo));
    }
    if (method === 'DELETE') { forge.deleteRepo(repo); return jsonReply(204, null); }
    return notFound();
  }

  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }));
      return jsonReply(200, branches);
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      if (!tip) return notFound();
      return jsonReply(200, { name: branch, commit: { sha: tip, url: '' }, protected: false });
    }
    return notFound();
  }

  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const tip = forge.resolveRef(repo, query.sha);
      if (!tip) return jsonReply(200, []);
      const commits = forge.listCommits(repo, tip).map((oid) => commitShape(repo, oid));
      return jsonReply(200, paginate(commits, query));
    }
    if (tail.length === 2 && method === 'GET') {
      const oid = tail[1] as string;
      if (!repo.objects.has(oid)) return notFound();
      return jsonReply(200, commitShape(repo, oid));
    }
    return notFound();
  }

  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('Invalid ref or sha');
      if (repo.refs.has(ref)) return unprocessable(`Reference already exists: ${ref}`);
      repo.refs.set(ref, sha);
      return jsonReply(201, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
    }
    if (tail.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, node_id: `REF_${ref}`, url: '', object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' } }));
      return jsonReply(200, refs);
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = tail.slice(2).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const oid = repo.refs.get(full);
      if (!oid) return notFound();
      return jsonReply(200, { ref: full, node_id: `REF_${full}`, url: '', object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' } });
    }
    if (tail.length >= 3 && method === 'DELETE') {
      const ref = tail.slice(2).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      repo.refs.delete(full);
      return jsonReply(204, null);
    }
    return notFound();
  }
  if (tail[0] === 'git' && tail[1] === 'ref' && tail.length >= 3 && method === 'GET') {
    const ref = tail.slice(2).join('/');
    const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
    const oid = repo.refs.get(full);
    if (!oid) return notFound();
    return jsonReply(200, { ref: full, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: '' } });
  }

  if (tail[0] === 'contents') {
    const contentPath = tail.slice(1).join('/');
    if (method === 'GET') return contentsGet(repo, contentPath, query.ref);
    if (method === 'PUT') return contentsPut(repo, contentPath, body);
    if (method === 'DELETE') return contentsDelete(repo, contentPath, body);
    return notFound();
  }

  if (tail[0] === 'labels') {
    if (tail.length === 1 && method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('Validation Failed: name is required');
      if (!repo.labels.has(name)) {
        repo.labels.set(name, {
          name,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        });
      }
      return jsonReply(201, labelShape(repo, name));
    }
    if (tail.length === 1 && method === 'GET') {
      return jsonReply(200, [...repo.labels.keys()].map((name) => labelShape(repo, name)));
    }
    if (tail.length === 2 && method === 'GET') {
      const name = tail[1] as string;
      if (!repo.labels.has(name)) return notFound();
      return jsonReply(200, labelShape(repo, name));
    }
    return notFound();
  }

  if (tail[0] === 'issues') return issuesRoute(repo, method, tail.slice(1), query, body);
  if (tail[0] === 'pulls') return pullsRoute(repo, method, tail.slice(1), query, body);
  void url;
  return notFound();
}

function commitShape(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object?.type === 'commit' ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', timestamp: 0, message: '' };
  const identity = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) /.exec(line);
    return {
      name: match?.[1] ?? VIEWER.name,
      email: match?.[2] ?? VIEWER.email,
      date: new Date((match ? Number(match[3]) : 0) * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: identity(commit.author),
      committer: identity(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: userShape(),
    committer: userShape(),
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

function contentsPut(repo: RepoRec, path: string, body: Record<string, unknown>): Reply {
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') return unprocessable('Validation Failed: path is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : `Update ${clean}`;
  const encoded = typeof body.content === 'string' ? body.content.replace(/\s+/g, '') : '';
  const data = Buffer.from(encoded, 'base64');
  const tip = forge.branchTip(repo, branch);
  const existing = tip ? forge.filesAtCommit(repo, tip).get(clean) : undefined;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing && givenSha !== undefined && givenSha !== existing.oid) {
    return jsonReply(409, { message: `${clean} does not match ${givenSha}` });
  }
  const { commitSha } = forge.commitOnBranch(repo, branch, (files) => { files.set(clean, data); }, message);
  const blobOid = forge.putObject(repo, 'blob', data);
  return jsonReply(existing ? 200 : 201, {
    content: {
      name: clean.split('/').pop(), path: clean, sha: blobOid, size: data.length, type: 'file', encoding: 'base64',
      content: data.toString('base64'),
      url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/contents/${clean}`,
      html_url: `https://forge.invalid/${repo.owner}/${repo.name}/blob/${branch}/${clean}`,
      git_url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      download_url: `https://forge.invalid/${repo.owner}/${repo.name}/raw/${branch}/${clean}`,
    },
    commit: { sha: commitSha, url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitSha}` },
  });
}

function contentsDelete(repo: RepoRec, path: string, body: Record<string, unknown>): Reply {
  const clean = path.replace(/^\/+|\/+$/g, '');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = forge.branchTip(repo, branch);
  const existing = tip ? forge.filesAtCommit(repo, tip).get(clean) : undefined;
  if (!existing) return notFound();
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (givenSha !== undefined && givenSha !== existing.oid) return jsonReply(409, { message: `${clean} does not match ${givenSha}` });
  const message = typeof body.message === 'string' ? body.message : `Delete ${clean}`;
  const { commitSha } = forge.commitOnBranch(repo, branch, (files) => { files.delete(clean); }, message);
  return jsonReply(200, { content: null, commit: { sha: commitSha, url: `https://forge.invalid/api/v3/repos/${repo.owner}/${repo.name}/commits/${commitSha}` } });
}

// ------------------------------------------------------------------ issues

function issuesRoute(repo: RepoRec, method: string, tail: string[], query: Record<string, string>, body: Record<string, unknown>): Reply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const labels = labelNamesOf(body.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label '${label}' does not exist`);
      }
      const issue = forge.createIssue(repo,
        typeof body.title === 'string' ? body.title : '',
        typeof body.body === 'string' ? body.body : '', labels);
      return jsonReply(201, issueShape(forge, repo, issue));
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      let issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      const direction = query.direction ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const total = issues.length;
      return jsonReply(200, paginate(issues, query).map((issue) => issueShape(forge, repo, issue)));
      void total;
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue) return notFound();
  if (tail.length === 1) {
    if (method === 'GET') {
      return cachedJson(`issue:${repo.owner}/${repo.name}:${issue.number}`, issueFingerprint(repo, issue),
        () => jsonReply(200, issueShape(forge, repo, issue)));
    }
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      const labels = body.labels === undefined ? null : labelNamesOf(body.labels);
      if (labels) {
        for (const label of labels) if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label '${label}' does not exist`);
        issue.labels = labels;
      }
      return jsonReply(200, issueShape(forge, repo, issue));
    }
    return notFound();
  }
  if (tail[1] === 'comments') {
    if (tail.length === 2 && method === 'POST') {
      const comment = forge.addComment(repo, issue, typeof body.body === 'string' ? body.body : '');
      return jsonReply(201, commentShape(forge, repo, issue, comment));
    }
    if (tail.length === 2 && method === 'GET') {
      return jsonReply(200, issue.comments.map((comment) => commentShape(forge, repo, issue, comment)));
    }
    if (tail.length === 3 && method === 'GET') {
      const comment = issue.comments.find((candidate) => candidate.id === Number(tail[2]));
      if (!comment) return notFound();
      return jsonReply(200, commentShape(forge, repo, issue, comment));
    }
  }
  if (tail[1] === 'labels' && method === 'GET') {
    return jsonReply(200, issue.labels.map((name) => labelShape(repo, name)));
  }
  return notFound();
}

function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).name === 'string') {
      names.push((entry as Record<string, unknown>).name as string);
    }
  }
  return names;
}

// ------------------------------------------------------------------ pulls

function pullsRoute(repo: RepoRec, method: string, tail: string[], query: Record<string, string>, body: Record<string, unknown>): Reply {
  if (tail.length === 0) {
    if (method === 'POST') {
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw.replace(/^refs\/heads\//, '');
      const base = typeof body.base === 'string' && body.base !== '' ? body.base.replace(/^refs\/heads\//, '') : repo.defaultBranch;
      if (head === '' || !forge.branchTip(repo, head)) return unprocessable(`Validation Failed: head branch '${head}' does not exist`);
      const pull = forge.createPull(repo,
        typeof body.title === 'string' ? body.title : '',
        typeof body.body === 'string' ? body.body : '', head, base);
      return jsonReply(201, pullShape(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'))
        .sort((a, b) => a.number - b.number);
      return jsonReply(200, paginate(pulls, query).map((pull) => pullShape(forge, repo, pull)));
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (!pull) return notFound();
  if (tail.length === 1) {
    if (method === 'GET') {
      return cachedJson(`pull:${repo.owner}/${repo.name}:${pull.number}`, pullFingerprint(repo, pull),
        () => jsonReply(200, pullShape(forge, repo, pull)));
    }
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      return jsonReply(200, pullShape(forge, repo, pull));
    }
    return notFound();
  }
  if (tail[1] === 'files' && tail.length === 2 && method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((file) => ({
      sha: '', filename: file.filename, status: file.status,
      additions: file.additions, deletions: file.deletions, changes: file.changes,
      blob_url: '', raw_url: '', contents_url: '',
    }));
    return jsonReply(200, paginate(files, query));
  }
  if (tail[1] === 'merge' && tail.length === 2 && (method === 'PUT' || method === 'POST')) {
    if (pull.merged) return jsonReply(200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
    const sha = forge.mergePull(repo, pull);
    if (!sha) return jsonReply(405, { message: 'Pull Request is not mergeable', documentation_url: 'https://forge.invalid/docs/pulls' });
    return jsonReply(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
  if (tail[1] === 'commits' && tail.length === 2 && method === 'GET') {
    const headTip = forge.branchTip(repo, pull.headRef);
    if (!headTip) return jsonReply(200, []);
    return jsonReply(200, forge.listCommits(repo, headTip).map((oid) => commitShape(repo, oid)));
  }
  return notFound();
}

// ------------------------------------------------------------------ git routing

function gitRoute(req: IncomingMessage, url: URL, rawBody: Buffer, res: ServerResponse): boolean {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!match) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const service = match[3] as string;
  const repo = forge.getRepo(owner, name);
  if (!repo) { sendJson(res, notFound()); return true; }
  const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'info/refs') {
    const wanted = url.searchParams.get('service');
    if (wanted !== 'git-upload-pack' && wanted !== 'git-receive-pack') {
      sendRaw(res, 400, 'text/plain; charset=utf-8', Buffer.from('missing or unknown service\n'));
      return true;
    }
    const body = advertise(repo, wanted, version2);
    sendRaw(res, 200, `application/x-${wanted}-advertisement`, body);
    return true;
  }
  if (service === 'git-upload-pack') {
    const firstLine = firstPktLine(rawBody);
    let body: Buffer;
    if (firstLine.startsWith('command=ls-refs')) body = lsRefs(repo, rawBody);
    else if (firstLine.startsWith('command=fetch')) body = gitFetch(repo, rawBody, true);
    else if (firstLine.startsWith('want ')) body = gitFetch(repo, rawBody, false);
    else { sendRaw(res, 400, 'text/plain; charset=utf-8', Buffer.from('malformed upload-pack request\n')); return true; }
    sendRaw(res, 200, 'application/x-git-upload-pack-result', body);
    return true;
  }
  // git-receive-pack
  const outcome = receivePack(repo, rawBody);
  sendRaw(res, outcome.status, outcome.status === 200 ? 'application/x-git-receive-pack-result' : 'text/plain; charset=utf-8', outcome.body);
  return true;
}

function firstPktLine(body: Buffer): string {
  if (body.length < 4) return '';
  const length = Number.parseInt(body.subarray(0, 4).toString('ascii'), 16);
  if (!Number.isFinite(length) || length <= 4 || body.length < length) return '';
  return body.subarray(4, length).toString('utf8');
}

// ------------------------------------------------------------------ the server

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawBody = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendRaw(res, 200, JSON_TYPE, Buffer.from('{"ok":true}\n'));
          return;
        }
        if (path.startsWith('/') && path.includes('.git/')) {
          if (gitRoute(req, url, rawBody, res)) return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          if (!authorized(req)) { sendJson(res, jsonReply(401, { message: 'Bad credentials' })); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(rawBody.toString('utf8')); }
          catch { sendJson(res, jsonReply(400, { errors: [{ message: 'Problems parsing JSON' }] })); return; }
          const executor = new GraphQLExecutor(forge);
          sendJson(res, jsonReply(200, executor.execute(parsed)));
          return;
        }
        if (path === '/mcp' && (method === 'POST' || method === 'GET')) {
          if (!authorized(req)) { sendJson(res, jsonReply(401, { message: 'Unauthorized' })); return; }
          if (method === 'GET') { sendJson(res, jsonReply(405, { message: 'Method Not Allowed' })); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(rawBody.toString('utf8')); }
          catch {
            const text = `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`;
            res.writeHead(400, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
            res.end(text);
            return;
          }
          if (Array.isArray(parsed)) {
            const answers = parsed.map((entry) => handleMcp(forge, entry as Record<string, unknown>)).filter((entry) => entry !== null);
            sendJson(res, jsonReply(200, answers));
            return;
          }
          const request = parsed as Record<string, unknown>;
          const answer = handleMcp(forge, request);
          if (answer === null) { res.writeHead(202); res.end(); return; }
          // A request without an id is a notification: no body back.
          if ((request as { id?: unknown }).id === undefined && typeof (request as { method?: unknown }).method === 'string') {
            res.writeHead(202); res.end(); return;
          }
          sendJson(res, jsonReply(200, answer));
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) { sendJson(res, jsonReply(401, { message: 'Bad credentials' })); return; }
          sendJson(res, restRoute(req, url, rawBody));
          return;
        }
        sendJson(res, notFound());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendJson(res, jsonReply(500, { message: `Internal error: ${message}` }));
        else res.end();
      }
    })();
  });
  // Loopback benchmarks notice TCP delay more than anything else: no Nagle, long keep-alive.
  server.on('connection', (socket) => { socket.setNoDelay(true); });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}
