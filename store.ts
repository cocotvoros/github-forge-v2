// store.ts — github-forge-v2's in-memory forge state: repositories with their git object stores,
// issues, pull requests, labels and comments. Every timestamp comes from a deterministic counter
// (base epoch + sequence), never the wall clock, so a live run and its replay export byte-identical
// state. Nothing here touches the network or the filesystem.

import {
  ZERO_OID, buildCommit, buildTree, collectReachable, hashObject, isAncestor, parseCommit, parseTag, parseTree,
  type GitObject, type GitType, type TreeEntry,
} from './gitobj.ts';

export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
});

const BASE_EPOCH_SEC = 1735689600;

export interface LabelRec { name: string; color: string; description: string }
export interface CommentRec { id: number; body: string; seq: number }
export interface IssueRec {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: CommentRec[]; seq: number;
}
export interface PullRec {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedSeq: number; mergeCommitSha: string | null;
  headRef: string; baseRef: string; baseShaAtCreation: string; seq: number;
}
export interface RepoRec {
  id: number; name: string; owner: string; description: string; isPrivate: boolean;
  defaultBranch: string; seq: number;
  objects: Map<string, GitObject>; refs: Map<string, string>;
  labels: Map<string, LabelRec>; issues: Map<number, IssueRec>; pulls: Map<number, PullRec>;
  nextIssue: number; nextPull: number;
}

export class Forge {
  private seq = 0;
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  readonly repos = new Map<string, RepoRec>();

  /** The next deterministic sequence number (also the timestamp source). */
  tick(): number { this.seq += 1; return this.seq; }
  isoOf(seq: number): string { return new Date((BASE_EPOCH_SEC + seq) * 1000).toISOString(); }
  nowIso(): string { return this.isoOf(this.seq); }

  // ---------------------------------------------------------- repositories

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec {
    const seq = this.tick();
    const repo: RepoRec = {
      id: this.nextRepoId, name, owner: VIEWER.login, description, isPrivate,
      defaultBranch: 'main', seq,
      objects: new Map(), refs: new Map(),
      labels: new Map(), issues: new Map(), pulls: new Map(),
      nextIssue: 1, nextPull: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  listRepos(): RepoRec[] { return [...this.repos.values()].sort((a, b) => a.seq - b.seq); }

  deleteRepo(repo: RepoRec): void { this.repos.delete(`${repo.owner}/${repo.name}`); }

  // ---------------------------------------------------------- git objects and refs

  lookup(repo: RepoRec, oid: string): GitObject | undefined { return repo.objects.get(oid); }

  putObject(repo: RepoRec, type: GitType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a branch name, a full ref, HEAD, or a raw sha to a commit sha (null when unborn/absent). */
  resolveRef(repo: RepoRec, ref: string | undefined): string | null {
    if (ref === undefined || ref === '' || ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
    if (repo.refs.has(`refs/tags/${ref}`)) {
      const tagged = repo.refs.get(`refs/tags/${ref}`) as string;
      return this.peel(repo, tagged);
    }
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return this.peel(repo, ref);
    return null;
  }

  peel(repo: RepoRec, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The file map (path -> blob oid and bytes) of a commit, walking its tree recursively. */
  filesAtCommit(repo: RepoRec, commitSha: string | null): Map<string, { oid: string; data: Buffer }> {
    const files = new Map<string, { oid: string; data: Buffer }>();
    if (!commitSha) return files;
    const commitObject = repo.objects.get(commitSha);
    if (!commitObject || commitObject.type !== 'commit') return files;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else {
          const blob = repo.objects.get(entry.oid);
          files.set(`${prefix}${entry.name}`, { oid: entry.oid, data: blob?.data ?? Buffer.alloc(0) });
        }
      }
    };
    walk(parseCommit(commitObject.data).tree, '');
    return files;
  }

  /** Build (and store) the nested tree for a path -> bytes map; returns the root tree oid. */
  treeFromFiles(repo: RepoRec, files: ReadonlyMap<string, Buffer>): string {
    interface Node { files: Map<string, Buffer>; dirs: Map<string, Node> }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, data] of files) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, data);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, data] of node.files) entries.push({ mode: '100644', name, oid: this.putObject(repo, 'blob', data) });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object from a full file map; returns its sha. Does not move any ref. */
  makeCommit(repo: RepoRec, files: ReadonlyMap<string, Buffer>, message: string, parents: readonly string[]): string {
    const tree = this.treeFromFiles(repo, files);
    const seq = this.tick();
    const data = buildCommit({
      tree, parents, message,
      authorName: VIEWER.name, authorEmail: VIEWER.email, timestamp: BASE_EPOCH_SEC + seq,
    });
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Replace the file map on a branch with `mutate` applied, commit it and move the branch.
   * A branch that does not exist yet is born from the default branch's tip (or empty).
   */
  commitOnBranch(
    repo: RepoRec, branch: string,
    mutate: (files: Map<string, Buffer>) => void,
    message: string,
  ): { commitSha: string; parent: string | null } {
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref) ?? null;
    if (parent === null && branch !== repo.defaultBranch) parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    const current = this.filesAtCommit(repo, parent);
    const files = new Map<string, Buffer>();
    for (const [path, entry] of current) files.set(path, entry.data);
    mutate(files);
    const commitSha = this.makeCommit(repo, files, message, parent ? [parent] : []);
    repo.refs.set(ref, commitSha);
    return { commitSha, parent };
  }

  /** Commits reachable from `tip`, newest first (breadth by ancestry, then by timestamp). */
  listCommits(repo: RepoRec, tip: string): string[] {
    const reachable = collectReachable((oid) => repo.objects.get(oid), [tip]);
    const commits = [...reachable].filter((oid) => repo.objects.get(oid)?.type === 'commit');
    commits.sort((a, b) => {
      const ca = parseCommit((repo.objects.get(a) as GitObject).data);
      const cb = parseCommit((repo.objects.get(b) as GitObject).data);
      return cb.timestamp - ca.timestamp;
    });
    // A stable newest-first order that respects parent-after-child for equal timestamps:
    // walk from the tip so a parent never precedes its child.
    const ordered: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid) || !commits.includes(oid)) continue;
      seen.add(oid);
      ordered.push(oid);
      const commit = parseCommit((repo.objects.get(oid) as GitObject).data);
      queue.push(...commit.parents);
    }
    for (const oid of commits) if (!seen.has(oid)) ordered.push(oid);
    return ordered;
  }

  mergeBase(repo: RepoRec, a: string, b: string): string | null {
    const ancestorsOf = (tip: string): Map<string, number> => {
      const distance = new Map<string, number>();
      const queue: Array<[string, number]> = [[tip, 0]];
      while (queue.length) {
        const [oid, depth] = queue.shift() as [string, number];
        if (distance.has(oid)) continue;
        distance.set(oid, depth);
        const object = repo.objects.get(oid);
        if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
      }
      return distance;
    };
    const fromA = ancestorsOf(a);
    const fromB = ancestorsOf(b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, depthA] of fromA) {
      const depthB = fromB.get(oid);
      if (depthB === undefined) continue;
      const score = depthA + depthB;
      if (score < bestScore) { bestScore = score; best = oid; }
    }
    return best;
  }

  // ---------------------------------------------------------- issues and pulls

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      id: this.nextIssueId, number: repo.nextIssue, title, body, state: 'open',
      labels: [...labels], comments: [], seq: this.tick(),
    };
    this.nextIssueId += 1;
    repo.nextIssue += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body, seq: this.tick() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const baseTip = this.branchTip(repo, baseRef);
    const pull: PullRec = {
      id: this.nextPullId, number: repo.nextPull, title, body, state: 'open',
      merged: false, mergedSeq: 0, mergeCommitSha: null,
      headRef, baseRef, baseShaAtCreation: baseTip ?? ZERO_OID, seq: this.tick(),
    };
    this.nextPullId += 1;
    repo.nextPull += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files of a pull: its head tree diffed against the base it was opened from. */
  pullFiles(repo: RepoRec, pull: PullRec): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseFiles = this.filesAtCommit(repo, pull.baseShaAtCreation === ZERO_OID ? null : pull.baseShaAtCreation);
    const headFiles = this.filesAtCommit(repo, headTip);
    const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const lines = (data: Buffer | undefined): number => (data === undefined || data.length === 0 ? 0 : data.toString('utf8').split('\n').length);
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = headFiles.get(path);
      if (before?.oid === after?.oid) continue;
      const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
      const additions = after === undefined ? 0 : Math.max(1, lines(after.data));
      const deletions = before === undefined ? 0 : Math.max(1, lines(before.data));
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Three-way merge analysis of a pull against the CURRENT base tip. */
  analyzeMerge(repo: RepoRec, pull: PullRec): { conflict: boolean; mergedFiles: Map<string, Buffer> | null; baseTip: string | null; headTip: string | null } {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (!baseTip || !headTip) return { conflict: true, mergedFiles: null, baseTip, headTip };
    if (pull.merged) return { conflict: false, mergedFiles: null, baseTip, headTip };
    const base = this.mergeBase(repo, baseTip, headTip);
    const ancestorFiles = this.filesAtCommit(repo, base);
    const baseFiles = this.filesAtCommit(repo, baseTip);
    const headFiles = this.filesAtCommit(repo, headTip);
    const paths = new Set<string>([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    const mergedFiles = new Map<string, Buffer>();
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path);
      const onBase = baseFiles.get(path);
      const onHead = headFiles.get(path);
      let chosen: { oid: string; data: Buffer } | undefined;
      if (onHead?.oid === ancestor?.oid) chosen = onBase;
      else if (onBase?.oid === ancestor?.oid) chosen = onHead;
      else if (onBase?.oid === onHead?.oid) chosen = onBase;
      else return { conflict: true, mergedFiles: null, baseTip, headTip };
      if (chosen) mergedFiles.set(path, chosen.data);
    }
    return { conflict: false, mergedFiles, baseTip, headTip };
  }

  /** Squash-merge a pull onto its base branch; returns the new commit sha, or null on conflict. */
  mergePull(repo: RepoRec, pull: PullRec): string | null {
    const analysis = this.analyzeMerge(repo, pull);
    if (analysis.conflict || !analysis.mergedFiles || !analysis.baseTip) return null;
    const commitSha = this.makeCommit(repo, analysis.mergedFiles, `${pull.title}\n\nSquashed pull request #${pull.number}`, [analysis.baseTip]);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSeq = this.tick();
    pull.mergeCommitSha = commitSha;
    return commitSha;
  }

  isAncestorIn(repo: RepoRec, ancestor: string, descendant: string): boolean {
    return isAncestor((oid) => repo.objects.get(oid), ancestor, descendant);
  }
}
