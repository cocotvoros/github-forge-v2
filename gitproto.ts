// gitproto.ts — the smart-HTTP wire for github-forge-v2: protocol v2 and v0 ref advertisements,
// v2 ls-refs, v2/v0 fetch with shallow windows, and v0 receive-pack with report-status.
// The semantics that matter, spelt out once:
//   * a full fetch sends closure(wants) minus closure(haves);
//   * a shallow fetch sends the FULL depth window from the wants — a `have` inside the window does
//     not cut window members — but a commit the client lists as `shallow` is not assumed to hold
//     its parents, so the have-closure stops at shallow-listed commits;
//   * receive-pack validates fast-forward per ref (reason exactly "non-fast-forward"), still
//     answers "unpack ok", and applies the acceptable refs of a mixed push.

import {
  PKT_FLUSH, ZERO_OID, collectReachable, decodePktLines, hashObject, isAncestor, isOid,
  parseCommit, parseTag, parseTree, pktLine, readPack, writePack, type GitObject,
} from './gitobj.ts';
import type { RepoRec } from './store.ts';

const AGENT = 'github-forge-v2/1.0';

function lookup(repo: RepoRec): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Peeled target of a ref value (through tag objects), or null when it is not a tag. */
function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const entry = repo.objects.get(current);
    if (!entry || entry.type !== 'tag') return current;
    current = parseTag(entry.data).object;
  }
  return current;
}

// ------------------------------------------------------------------ advertisements

export function advertise(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): Buffer {
  if (service === 'git-upload-pack' && version2) {
    return Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
  }
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines: string[] = [];
  if (service === 'git-upload-pack') {
    const caps = `side-band-64k shallow ofs-delta thin-pack symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    lines.push(`${headTip ?? ZERO_OID} HEAD\0${caps}`);
    for (const [ref, oid] of sortedRefs(repo)) {
      lines.push(`${oid} ${ref}`);
      const peeled = peeledOf(repo, oid);
      if (peeled) lines.push(`${peeled} ${ref}^{}`);
    }
  } else {
    const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
    const refs = sortedRefs(repo);
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}`);
    } else {
      refs.forEach(([ref, oid], index) => {
        lines.push(index === 0 ? `${oid} ${ref}\0${caps}` : `${oid} ${ref}`);
        const peeled = peeledOf(repo, oid);
        if (peeled) lines.push(`${peeled} ${ref}^{}`);
      });
    }
  }
  for (const line of lines) parts.push(pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

export function lsRefs(repo: RepoRec, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  let afterDelim = false;
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') { afterDelim = true; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(defaultRef);
  if (matches('HEAD')) {
    if (headTip) {
      out.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    } else if (unborn) {
      out.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[]; haves: string[]; shallow: string[];
  depth: number | null; deepenSince: number | null; deepenNot: string[];
}

/** Commit closure that stops descending at the client's shallow-listed commits. */
function haveClosure(repo: RepoRec, haves: readonly string[], shallowListed: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || !isOid(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallowListed.has(oid)) queue.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeEntries(repo, oid)) queue.push(entry);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

function parseTreeEntries(repo: RepoRec, treeOid: string): string[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => entry.oid);
}

interface FetchPlan { send: Set<string>; shallow: string[]; unshallow: string[] }

function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const get = lookup(repo);
  const shallowListed = new Set(args.shallow);
  const shallowMode = args.depth !== null || args.deepenSince !== null || args.deepenNot.length > 0;
  if (!shallowMode) {
    const wantClosure = collectReachable(get, args.wants);
    const have = collectReachable(get, args.haves);
    const send = new Set<string>();
    for (const oid of wantClosure) if (!have.has(oid)) send.add(oid);
    return { send, shallow: [], unshallow: [] };
  }
  // Shallow: build the window of commits the client should hold after this fetch.
  const window = new Map<string, number>(); // commit oid -> generation from the wants (0-based)
  const queue: Array<[string, number]> = [];
  const extraObjects = new Set<string>(); // tag objects named directly by a want
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') extraObjects.add(want);
    const commitOid = object.type === 'tag' ? repoPeel(repo, want) : want;
    if (repo.objects.get(commitOid)?.type === 'commit') queue.push([commitOid, 0]);
  }
  const notCommits = new Set<string>();
  for (const not of args.deepenNot) {
    const tip = repo.refs.get(not) ?? repo.refs.get(`refs/heads/${not}`) ?? not;
    for (const oid of collectReachable(get, [tip])) {
      if (repo.objects.get(oid)?.type === 'commit') notCommits.add(oid);
    }
  }
  while (queue.length) {
    const [oid, generation] = queue.shift() as [string, number];
    if (window.has(oid) && (window.get(oid) as number) <= generation) continue;
    if (notCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (args.deepenSince !== null && commit.timestamp < args.deepenSince) continue;
    window.set(oid, generation);
    // With a depth cap, never walk past the window: parents at generation `depth` are boundary
    // evidence only (their existence is checked against the store, not by visiting them).
    if (args.depth !== null && generation + 1 >= args.depth) continue;
    for (const parent of commit.parents) queue.push([parent, generation + 1]);
  }
  const send = new Set<string>(extraObjects);
  for (const oid of window.keys()) {
    send.add(oid);
    const commit = parseCommit((repo.objects.get(oid) as GitObject).data);
    for (const reachable of collectReachable(get, [commit.tree])) send.add(reachable);
  }
  const have = haveClosure(repo, args.haves, shallowListed);
  for (const oid of have) send.delete(oid);
  // Boundary: window commits with a parent in the store that is not itself in the window.
  const shallow: string[] = [];
  for (const oid of window.keys()) {
    const commit = parseCommit((repo.objects.get(oid) as GitObject).data);
    if (commit.parents.some((parent) => repo.objects.has(parent) && !window.has(parent))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of args.shallow) {
    if (window.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
  }
  return { send, shallow, unshallow };
}

function repoPeel(repo: RepoRec, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

export function fetch(repo: RepoRec, body: Buffer, version2: boolean): Buffer {
  const { packets } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const [word, rest] = splitOnce(line);
    if (word === 'want') { const oid = rest.split(' ')[0] as string; if (isOid(oid)) args.wants.push(oid); }
    else if (word === 'have') { if (isOid(rest)) args.haves.push(rest); }
    else if (word === 'shallow') { if (isOid(rest)) args.shallow.push(rest); }
    else if (word === 'deepen') { const value = Number(rest); if (Number.isFinite(value)) args.depth = value; }
    else if (word === 'deepen-since') { const value = Number(rest); if (Number.isFinite(value)) args.deepenSince = value; }
    else if (word === 'deepen-not') args.deepenNot.push(rest);
  }
  const plan = planFetch(repo, args);
  const objects: GitObject[] = [];
  for (const oid of plan.send) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (version2) {
    if (args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const known = args.haves.filter((have) => repo.objects.has(have));
      if (known.length === 0) parts.push(pktLine('NAK\n'));
      for (const have of known) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
      parts.push(PKT_FLUSH);
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  } else {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLine('NAK\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function splitOnce(line: string): [string, string] {
  const space = line.indexOf(' ');
  return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1)];
}

// ------------------------------------------------------------------ receive-pack

export interface PushOutcome { status: number; body: Buffer }

export function receivePack(repo: RepoRec, body: Buffer): PushOutcome {
  const { packets, next } = decodePktLines(body);
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') { sawFlush = true; break; }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) { capabilities = line.slice(nul + 1); line = line.slice(0, nul); }
    const fields = line.split(' ');
    if (fields.length >= 3 && isOid(fields[0] as string) && isOid(fields[1] as string)) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields.slice(2).join(' ') });
    }
  }
  if (!sawFlush || commands.length === 0) return { status: 400, body: Buffer.from('malformed receive-pack request\n') };
  const packBytes = body.subarray(next);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        if (hashObject(object.type, object.data) !== oid) throw new Error('pack object hash mismatch');
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const wantsReport = capabilities.split(' ').includes('report-status');
  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) { reportLines.push(`ng ${command.ref} unpack failed\n`); continue; }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (!newObject) { reportLines.push(`ng ${command.ref} missing object\n`); continue; }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== ZERO_OID && current !== command.newOid) {
      const currentCommit = repoPeel(repo, current);
      const newCommit = repoPeel(repo, command.newOid);
      const fastForward = currentCommit === newCommit
        || (repo.objects.get(newCommit)?.type === 'commit' && isAncestor(lookup(repo), currentCommit, newCommit));
      if (!fastForward) { reportLines.push(`ng ${command.ref} non-fast-forward\n`); continue; }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  if (!wantsReport) return { status: 200, body: Buffer.alloc(0) };
  const reportStream = Buffer.concat(reportLines.map((line) => pktLine(line)));
  if (useSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(parts) };
  }
  return { status: 200, body: Buffer.concat([reportStream, PKT_FLUSH]) };
}
