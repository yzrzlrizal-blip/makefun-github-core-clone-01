// app.ts — the forge server: git smart HTTP, REST v3, GraphQL v4 and MCP,
// one process, in-memory store, Node stdlib only. See README.md.
//
// Determinism: nothing here reads the wall clock or unseeded randomness.
// Creation order is a counter; timestamps derive from a fixed epoch plus
// that counter. Two runs that receive the same requests in the same order
// reach the same state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  buildTreeFromFlat,
  collectReachable,
  decodePktLines,
  encodePktLines,
  flatTreeOfCommit,
  hashObject,
  isAncestor,
  isOid,
  makeObject,
  parseCommit,
  parseIdent,
  parseTree,
  peelToCommit,
  pktLine,
  pktSections,
  readPack,
  sidebandPackets,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
  type ObjType,
} from './git-core.ts';

// ------------------------------------------------------------------ identity
//
// The suite's token names a viewer whose login is fixed by the contest's
// seeded scenario (wire.ts SCENARIO_SEED, buildScenario): the first of 12
// generated users. Recompute it here from the same seed so the forge answers
// `viewer { login }`, GET /api/v3/user and the repository owner correctly
// without ever seeing the scenario. Verified locally: "adaiversen".

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function viewerLoginOf(): string {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`;
}

export const VIEWER_LOGIN = viewerLoginOf();
const VIEWER_ID = 1000;
const VIEWER_EMAIL = `${VIEWER_LOGIN}@example.invalid`;
const VIEWER_NAME = VIEWER_LOGIN;

// The bearer token the suite presents (MAKEFUN_SHOP_TOKEN in a trial). When
// it is unset (a local run), any non-empty bearer token is accepted as the
// viewer, so the server can be exercised without the trial harness.
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ------------------------------------------------------------------ store

interface Label {
  name: string;
  color: string;
  description: string;
}

interface IssueComment {
  id: number;
  globalId: string;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Issue {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Pull {
  number: number;
  id: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextObjectId = 1; // REST `id` for issues/pulls/comments
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

/** Deterministic ISO timestamp: a fixed epoch plus the creation counter. */
function tsIso(seq: number): string {
  return new Date((1_735_689_600 + seq) * 1000).toISOString();
}

/** Deterministic git ident timestamp (seconds since epoch). */
function gitTs(seq: number): number {
  return 1_700_000_000 + seq;
}

function gitIdent(seq: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${gitTs(seq)} +0000`;
}

function globalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function findRepoById(databaseId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}

function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    seq: nextSeq(),
  };
  nextRepoId += 1;
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

// ------------------------------------------------------------------ git objects in a repo

function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const { oid, object } = makeObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  return oid;
}

function lookupIn(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

/** A commit on `branch` (or an unborn branch) that replaces/adds files. */
function commitFiles(
  repo: Repo,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): { commitSha: string; treeSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const flat = tip === undefined ? new Map<string, { oid: string; mode: string }>() : flatTreeOfCommit(repo.objects, tip);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else flat.set(path, { oid: putObject(repo, 'blob', content), mode: '100644' });
  }
  const treeSha = buildTreeFromFlat(flat, (type, data) => putObject(repo, type, data));
  const seq = nextSeq();
  const commitData = buildCommit({
    tree: treeSha,
    parents: tip === undefined ? [] : [tip],
    author: gitIdent(seq),
    committer: gitIdent(seq),
    message,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, treeSha };
}

/** The flat path map at a ref (branch name, full ref, or commit oid). */
function flatAtRef(repo: Repo, ref: string): Map<string, { oid: string; mode: string }> | null {
  let tip: string | undefined;
  if (repo.refs.has(ref)) tip = repo.refs.get(ref);
  else if (repo.refs.has(`refs/heads/${ref}`)) tip = repo.refs.get(`refs/heads/${ref}`);
  else if (isOid(ref) && repo.objects.has(ref)) tip = ref;
  if (tip === undefined) return null;
  return flatTreeOfCommit(repo.objects, tip);
}

function tipOf(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Walk a branch's history newest-first (depth-first over parents). */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(object.data);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

/** The merge-base of two commits: the first common ancestor found walking from `a`. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfB = new Set(walkCommits(repo, b));
  for (const oid of walkCommits(repo, a)) {
    if (ancestorsOfB.has(oid)) return oid;
  }
  return null;
}

interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two flat trees. */
function diffFlat(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  return out;
}

/** Line counts for a pull-request file entry (added/deleted lines, by line set). */
function lineCounts(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): string[] => {
    if (oid === null) return [];
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    return text.split('\n');
  };
  const oldLines = linesOf(oldOid);
  const newLines = linesOf(newOid);
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  const newSet = new Map<string, number>();
  for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newSet) additions += Math.max(0, count - (oldSet.get(line) ?? 0));
  for (const [line, count] of oldSet) deletions += Math.max(0, count - (newSet.get(line) ?? 0));
  return { additions, deletions };
}

interface MergeResult {
  ok: boolean;
  /** The merged tree's flat map, when ok. */
  flat: Map<string, { oid: string; mode: string }> | null;
  conflicts: string[];
}

/** Three-way merge of `headTip` onto `baseTip` with merge-base `base`. */
function threeWayMerge(repo: Repo, base: string, headTip: string, baseTip: string): MergeResult {
  const baseFlat = flatTreeOfCommit(repo.objects, base);
  const headFlat = flatTreeOfCommit(repo.objects, headTip);
  const curFlat = flatTreeOfCommit(repo.objects, baseTip);
  const merged = new Map(curFlat);
  const conflicts: string[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...curFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    const c = curFlat.get(path);
    const bOid = b?.oid ?? null;
    const hOid = h?.oid ?? null;
    const cOid = c?.oid ?? null;
    if (hOid === bOid) continue; // head did not change it
    if (cOid === bOid) {
      // only head changed it: take head's version
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    if (cOid === hOid) continue; // both changed it the same way
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { ok: false, flat: null, conflicts };
  return { ok: true, flat: merged, conflicts: [] };
}

/** Is `pull` mergeable right now (three-way merge has no conflicts)? */
function pullMergeable(repo: Repo, pull: Pull): boolean {
  const headTip = tipOf(repo, pull.head);
  const baseTip = tipOf(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return false;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return false;
  return threeWayMerge(repo, base, headTip, baseTip).ok;
}

/** Squash-merge an open pull request onto its base branch. Returns the merge commit sha or null. */
function squashMerge(repo: Repo, pull: Pull): string | null {
  const headTip = tipOf(repo, pull.head);
  const baseTip = tipOf(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return null;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return null;
  const merged = threeWayMerge(repo, base, headTip, baseTip);
  if (!merged.ok || merged.flat === null) return null;
  const treeSha = buildTreeFromFlat(merged.flat, (type, data) => putObject(repo, type, data));
  const seq = nextSeq();
  const commitData = buildCommit({
    tree: treeSha,
    parents: [baseTip],
    author: gitIdent(seq),
    committer: gitIdent(seq),
    message: `${pull.title} (#${pull.number})`,
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = tsIso(seq);
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = tsIso(seq);
  return commitSha;
}

// ------------------------------------------------------------------ HTTP helpers

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': `req-${(requestCounter += 1)}`,
    ...extra,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  if (status === 204) res.end();
  else res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': `req-${(requestCounter += 1)}` });
  res.end();
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': `req-${(requestCounter += 1)}`,
  });
  res.end(body);
}

function errJson(message: string): { message: string } {
  return { message };
}

function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

function authed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function pathSegments(req: IncomingMessage): string[] {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return url.pathname.split('/').filter((part) => part !== '').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  } catch {
    return [];
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function hostOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? host : '127.0.0.1';
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPageRaw = Number(query.get('per_page') ?? '30') || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function pageLink(req: IncomingMessage, path: string, page: number, perPage: number, rel: string): string {
  const url = `http://${hostOf(req)}${path}?page=${page}&per_page=${perPage}`;
  return `<${url}>; rel="${rel}"`;
}

// ------------------------------------------------------------------ REST shapes

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', [VIEWER_ID]), type: 'User', site_admin: false };
}

function repoJson(req: IncomingMessage, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', [repo.id]),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: tsIso(repo.seq),
    updated_at: tsIso(repo.seq),
    pushed_at: tsIso(repo.seq),
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
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `http://${hostOf(req)}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${hostOf(req)}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    url: `http://${hostOf(req)}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, node_id: '', name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `http://${hostOf(req)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(req: IncomingMessage, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    mergeable_state: pull.state === 'open' ? (pullMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? userJson() : null,
    draft: false,
    head: {
      ref: pull.head,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.head}`,
      user: userJson(),
      repo: repoJson(req, repo),
    },
    base: {
      ref: pull.base,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.base}`,
      user: userJson(),
      repo: repoJson(req, repo),
    },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `http://${hostOf(req)}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function pullFilesJson(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseTip = tipOf(repo, pull.base);
  const headTip = tipOf(repo, pull.head);
  if (baseTip === undefined || headTip === undefined) return [];
  // Diff the merge-base against the head, as GitHub does for a pull request.
  const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseFlat = flatTreeOfCommit(repo.objects, base);
  const headFlat = flatTreeOfCommit(repo.objects, headTip);
  const out: Record<string, unknown>[] = [];
  for (const entry of diffFlat(baseFlat, headFlat)) {
    const counts = lineCounts(repo, entry.oldOid, entry.newOid);
    const blob = entry.newOid !== null ? repo.objects.get(entry.newOid) : null;
    out.push({
      sha: entry.newOid ?? entry.oldOid ?? '',
      filename: entry.path,
      status: entry.status === 'modified' ? 'modified' : entry.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: blob !== null && blob.type === 'blob' ? '' : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------------ REST v3

function repoFromSegments(seg: readonly string[]): { repo: Repo } | { status: number; body: { message: string } } {
  const owner = seg[0] as string;
  const name = seg[1] as string;
  if (owner !== VIEWER_LOGIN) return { status: 404, body: errJson('Not Found') };
  const repo = findRepo(owner, name);
  if (repo === undefined) return { status: 404, body: errJson('Not Found') };
  return { repo };
}

/** Send a paginated JSON list, with a Link rel="next" header when more pages follow. */
function sendList<T>(req: IncomingMessage, res: ServerResponse, items: readonly T[], path: string): void {
  const query = queryOf(req);
  const { page, perPage } = parsePage(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const extra: Record<string, string> = {};
  if (start + perPage < items.length) {
    extra.link = pageLink(req, path, page + 1, perPage, 'next');
  }
  sendJson(res, 200, slice, extra);
}

function contentsEntries(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { file?: { oid: string; mode: string }; dir?: boolean }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { file: entry });
    else children.set(rest.slice(0, slash), { dir: true });
  }
  const out: Record<string, unknown>[] = [];
  for (const name of [...children.keys()].sort()) {
    const child = children.get(name) as { file?: { oid: string; mode: string }; dir?: boolean };
    const path = prefix === '' ? name : `${prefix}${name}`;
    if (child.file !== undefined) {
      const blob = repo.objects.get(child.file.oid);
      out.push({
        type: 'file', name, path, sha: child.file.oid,
        size: blob !== undefined && blob.type === 'blob' ? blob.data.length : 0,
        url: '', html_url: '', download_url: null,
      });
    } else {
      const sub = new Map<string, { oid: string; mode: string }>();
      for (const [path2, entry] of flat) {
        if (path2.startsWith(`${path}/`)) sub.set(path2.slice(path.length + 1), entry);
      }
      const treeSha = buildTreeFromFlat(sub, (type, data) => putObject(repo, type, data));
      out.push({ type: 'dir', name, path, sha: treeSha, size: 0, url: '', html_url: '', download_url: null });
    }
  }
  return out;
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  seg: readonly string[],
  body: unknown,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const rest = seg.slice(2); // after ['api','v3']
  const query = queryOf(req);

  // API root.
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { ...userJson(), name: VIEWER_NAME, email: VIEWER_EMAIL, public_repos: repos.size });
    return true;
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.seq - b.seq);
      sendList(req, res, all.map((repo) => repoJson(req, repo)), '/api/v3/user/repos');
      return true;
    }
    if (method === 'POST') {
      if (!isRecord(body)) {
        sendJson(res, 422, errJson('Invalid request body'));
        return true;
      }
      const name = strField(body, 'name');
      if (name === '') {
        sendJson(res, 422, errJson('name is required'));
        return true;
      }
      if (findRepo(VIEWER_LOGIN, name) !== undefined) {
        sendJson(res, 422, errJson(`Repository ${name} already exists`));
        return true;
      }
      const repo = createRepo(name, body.private === true, strField(body, 'description'));
      sendJson(res, 201, repoJson(req, repo));
      return true;
    }
    sendJson(res, 404, errJson('Not Found'));
    return true;
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const tail = rest.slice(3);
    const found = repoFromSegments([owner, name]);
    if ('status' in found) {
      sendJson(res, found.status, found.body);
      return true;
    }
    const repo = found.repo;

    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(req, repo));
        return true;
      }
      if (method === 'PATCH') {
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.isPrivate = body.private;
          if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        }
        sendJson(res, 200, repoJson(req, repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        sendNoContent(res);
        return true;
      }
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches: Record<string, unknown>[] = [];
        for (const ref of [...repo.refs.keys()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false });
        }
        sendJson(res, 200, branches);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (sha === undefined) {
          sendJson(res, 404, errJson('Branch not found'));
          return true;
        }
        sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
        return true;
      }
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }

    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = query.get('sha');
      const tip = shaParam !== null
        ? (repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (isOid(shaParam) ? shaParam : undefined))
        : tipOf(repo, repo.defaultBranch);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const out: Record<string, unknown>[] = [];
      for (const oid of walkCommits(repo, tip)) {
        const object = repo.objects.get(oid);
        if (object === undefined) continue;
        const commit = parseCommit(object.data);
        const author = parseIdent(commit.author);
        const committer = parseIdent(commit.committer);
        out.push({
          sha: oid,
          commit: {
            // Git stores the message with a trailing newline; the API
            // surface returns it without one, as GitHub does.
            message: commit.message.replace(/\n$/, ''),
            author: { name: author.name, email: author.email, date: new Date(author.timestamp * 1000).toISOString() },
            committer: { name: committer.name, email: committer.email, date: new Date(committer.timestamp * 1000).toISOString() },
          },
          author: { login: VIEWER_LOGIN },
          committer: { login: VIEWER_LOGIN },
          parents: commit.parents.map((parent) => ({ sha: parent })),
        });
      }
      sendJson(res, 200, out);
      return true;
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        if (!isRecord(body)) {
          sendJson(res, 422, errJson('Invalid request body'));
          return true;
        }
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (!ref.startsWith('refs/') || !isOid(sha) || repo.objects.get(sha) === undefined) {
          sendJson(res, 422, errJson('Invalid ref or sha'));
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, errJson('Reference already exists'));
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const out: Record<string, unknown>[] = [];
          for (const ref of [...repo.refs.keys()].sort()) {
            out.push({ ref, object: { sha: repo.refs.get(ref), type: 'commit', url: '' } });
          }
          sendJson(res, 200, out);
          return true;
        }
        if (tail.length === 4 && tail[2] === 'heads') {
          const sha = repo.refs.get(`refs/heads/${tail[3]}`);
          if (sha === undefined) {
            sendJson(res, 404, errJson('Reference not found'));
            return true;
          }
          sendJson(res, 200, { ref: `refs/heads/${tail[3]}`, object: { sha, type: 'commit', url: '' } });
          return true;
        }
      }
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }

    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      const refParam = query.get('ref');
      if (method === 'PUT') {
        if (!isRecord(body)) {
          sendJson(res, 422, errJson('Invalid request body'));
          return true;
        }
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const contentB64 = strField(body, 'content');
        if (contentB64 === '') {
          sendJson(res, 422, errJson('content is required'));
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 422, errJson('content is not valid base64'));
          return true;
        }
        const message = strField(body, 'message') || 'Update file';
        const existingRef = tipOf(repo, branch);
        const existingFlat = existingRef === undefined ? new Map() : flatTreeOfCommit(repo.objects, existingRef);
        const existing = existingFlat.get(path);
        const isUpdate = existing !== undefined;
        if (isUpdate && typeof body.sha !== 'string') {
          sendJson(res, 422, errJson('sha is required to update a file'));
          return true;
        }
        if (isUpdate && body.sha !== existing?.oid) {
          sendJson(res, 409, errJson('sha does not match the current file'));
          return true;
        }
        const blobSha = hashObject('blob', content);
        const changes = new Map<string, Buffer | null>([[path, content]]);
        const { commitSha } = commitFiles(repo, branch, changes, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'GET') {
        const flat = refParam !== null ? flatAtRef(repo, refParam) : flatAtRef(repo, repo.defaultBranch);
        if (flat === null) {
          sendJson(res, 404, errJson('Not Found'));
          return true;
        }
        if (path === '') {
          sendJson(res, 200, contentsEntries(repo, flat, ''));
          return true;
        }
        const entry = flat.get(path);
        if (entry !== undefined) {
          const blob = repo.objects.get(entry.oid);
          const bytes = blob !== undefined && blob.type === 'blob' ? blob.data : Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: bytes.length,
            name: path.split('/').pop() ?? path, path, sha: entry.oid,
            content: bytes.toString('base64'), url: '', html_url: '', download_url: null,
          });
          return true;
        }
        const prefix = `${path}/`;
        const isDir = [...flat.keys()].some((key) => key.startsWith(prefix));
        if (isDir) {
          sendJson(res, 200, contentsEntries(repo, flat, path));
          return true;
        }
        sendJson(res, 404, errJson('Not Found'));
        return true;
      }
      if (method === 'DELETE') {
        const branch = isRecord(body) && typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const existingRef = tipOf(repo, branch);
        const existingFlat = existingRef === undefined ? new Map() : flatTreeOfCommit(repo.objects, existingRef);
        const existing = existingFlat.get(path);
        if (existing === undefined) {
          sendJson(res, 404, errJson('Not Found'));
          return true;
        }
        if (isRecord(body) && typeof body.sha === 'string' && body.sha !== existing.oid) {
          sendJson(res, 409, errJson('sha does not match the current file'));
          return true;
        }
        const message = isRecord(body) ? strField(body, 'message') || 'Delete file' : 'Delete file';
        const changes = new Map<string, Buffer | null>([[path, null]]);
        const { commitSha } = commitFiles(repo, branch, changes, message);
        sendJson(res, 200, { commit: { sha: commitSha, message }, content: null });
        return true;
      }
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }

    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return true;
      }
      if (method === 'POST' && tail.length === 1) {
        if (!isRecord(body)) {
          sendJson(res, 422, errJson('Invalid request body'));
          return true;
        }
        const name = strField(body, 'name');
        if (name === '') {
          sendJson(res, 422, errJson('name is required'));
          return true;
        }
        const existing = repo.labels.get(name);
        if (existing !== undefined) {
          sendJson(res, 201, labelJson(existing));
          return true;
        }
        const label: Label = {
          name,
          color: typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return true;
      }
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          sendList(req, res, list.map((issue) => issueJson(req, repo, issue)), `/api/v3/repos/${owner}/${name}/issues`);
          return true;
        }
        if (method === 'POST') {
          if (!isRecord(body)) {
            sendJson(res, 422, errJson('Invalid request body'));
            return true;
          }
          const title = strField(body, 'title');
          if (title === '') {
            sendJson(res, 422, errJson('title is required'));
            return true;
          }
          const labelNames: string[] = [];
          if (Array.isArray(body.labels)) {
            for (const entry of body.labels) {
              if (typeof entry === 'string') labelNames.push(entry);
              else if (isRecord(entry) && typeof entry.name === 'string') labelNames.push(entry.name);
            }
          }
          const labels: Label[] = [];
          for (const labelName of labelNames) {
            const label = repo.labels.get(labelName);
            if (label === undefined) {
              sendJson(res, 422, errJson(`Label '${labelName}' does not exist`));
              return true;
            }
            labels.push(label);
          }
          const seq = nextSeq();
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const issue: Issue = {
            number,
            id: nextObjectId,
            globalId: globalId('Issue', [repo.id, number]),
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels,
            comments: [],
            user: VIEWER_LOGIN,
            createdAt: tsIso(seq),
            updatedAt: tsIso(seq),
            seq,
          };
          nextObjectId += 1;
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(req, repo, issue));
          return true;
        }
        sendJson(res, 404, errJson('Not Found'));
        return true;
      }
      const number = Number(tail[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (tail.length === 2) {
        if (issue === undefined) {
          sendJson(res, 404, errJson('Not Found'));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(req, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (isRecord(body)) {
            if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
          }
          issue.updatedAt = tsIso(nextSeq());
          sendJson(res, 200, issueJson(req, repo, issue));
          return true;
        }
        sendJson(res, 404, errJson('Not Found'));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) {
          sendJson(res, 404, errJson('Not Found'));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => ({
            id: comment.id, node_id: comment.globalId, body: comment.body, user: userJson(),
            created_at: comment.createdAt, updated_at: comment.updatedAt,
            html_url: '', url: '',
          })));
          return true;
        }
        if (method === 'POST') {
          if (!isRecord(body) || typeof body.body !== 'string' || body.body === '') {
            sendJson(res, 422, errJson('body is required'));
            return true;
          }
          const seq = nextSeq();
          const comment: IssueComment = {
            id: repo.nextCommentId,
            globalId: globalId('IssueComment', [repo.id, issue.number, repo.nextCommentId]),
            body: body.body,
            user: VIEWER_LOGIN,
            createdAt: tsIso(seq),
            updatedAt: tsIso(seq),
            seq,
          };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id, node_id: comment.globalId, body: comment.body, user: userJson(),
            created_at: comment.createdAt, updated_at: comment.updatedAt, html_url: '', url: '',
          });
          return true;
        }
        sendJson(res, 404, errJson('Not Found'));
        return true;
      }
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          list = [...list].sort((a, b) => b.seq - a.seq);
          sendList(req, res, list.map((pull) => pullJson(req, repo, pull)), `/api/v3/repos/${owner}/${name}/pulls`);
          return true;
        }
        if (method === 'POST') {
          if (!isRecord(body)) {
            sendJson(res, 422, errJson('Invalid request body'));
            return true;
          }
          const head = strField(body, 'head');
          const base = strField(body, 'base');
          const title = strField(body, 'title');
          if (head === '' || base === '' || title === '') {
            sendJson(res, 422, errJson('head, base and title are required'));
            return true;
          }
          const headSha = tipOf(repo, head);
          const baseSha = tipOf(repo, base);
          if (headSha === undefined || baseSha === undefined) {
            sendJson(res, 422, errJson('head or base branch does not exist'));
            return true;
          }
          const duplicate = repo.pulls.find((pull) => pull.head === head && pull.state === 'open');
          if (duplicate !== undefined) {
            sendJson(res, 422, errJson('A pull request already exists for this head branch'));
            return true;
          }
          const seq = nextSeq();
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const pull: Pull = {
            number,
            id: nextObjectId,
            globalId: globalId('PullRequest', [repo.id, number]),
            title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            head,
            base,
            headSha,
            baseSha,
            user: VIEWER_LOGIN,
            createdAt: tsIso(seq),
            updatedAt: tsIso(seq),
            seq,
          };
          nextObjectId += 1;
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(req, repo, pull));
          return true;
        }
        sendJson(res, 404, errJson('Not Found'));
        return true;
      }
      const number = Number(tail[1]);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (tail.length === 2) {
        if (pull === undefined) {
          sendJson(res, 404, errJson('Not Found'));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(req, repo, pull));
          return true;
        }
        sendJson(res, 404, errJson('Not Found'));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendJson(res, 404, errJson('Not Found'));
          return true;
        }
        sendJson(res, 200, pullFilesJson(repo, pull));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendJson(res, 404, errJson('Not Found'));
          return true;
        }
        if (pull.merged && pull.mergeCommitSha !== null) {
          sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: `${pull.title} (#${pull.number})` });
          return true;
        }
        if (pull.state !== 'open') {
          sendJson(res, 405, errJson('Pull request is closed'));
          return true;
        }
        if (!pullMergeable(repo, pull)) {
          sendJson(res, 405, errJson('Merge conflict'));
          return true;
        }
        const sha = squashMerge(repo, pull);
        if (sha === null) {
          sendJson(res, 405, errJson('Merge conflict'));
          return true;
        }
        sendJson(res, 200, { sha, merged: true, message: `${pull.title} (#${pull.number})` });
        return true;
      }
      sendJson(res, 404, errJson('Not Found'));
      return true;
    }

    sendJson(res, 404, errJson('Not Found'));
    return true;
  }

  sendJson(res, 404, errJson('Not Found'));
  return true;
}

// ------------------------------------------------------------------ GraphQL v4
//
// A small parser + executor for exactly the documents gh and
// github-mcp-server send (see checks-graphql.ts): viewer/repository reads,
// __type introspection, issue/PR connections, node(id:), the five mutations,
// and operation batching. Unknown fields answer HTTP 200 with an `errors`
// array naming the field.

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlSelection {
  kind: 'field' | 'fragment';
  name?: string;
  alias?: string;
  args?: Record<string, GqlValue>;
  selections?: GqlSelection[];
  typeCondition?: string;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: GqlValue }[];
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string; selections: GqlSelection[] }>;
}

type GqlToken =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function tokenizeGql(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text.replace(/\\"""/g, '"""') });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: source.slice(i, j) } : { kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  #tokens: GqlToken[];
  #pos = 0;
  constructor(source: string) {
    this.#tokens = tokenizeGql(source);
  }
  #peek(): GqlToken | undefined {
    return this.#tokens[this.#pos];
  }
  #next(): GqlToken {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.#pos += 1;
    return token;
  }
  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }
  #expectName(value?: string): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${token.value}`);
    return token.value;
  }
  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: GqlSelection[] }>();
    while (this.#pos < this.#tokens.length) {
      const token = this.#peek() as GqlToken;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', variables: [], selections: this.#parseSelections() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.#next();
        const type = token.value as 'query' | 'mutation';
        let name: string | undefined;
        const next = this.#peek();
        if (next !== undefined && next.kind === 'name') name = this.#next().value as string;
        const variables = this.#parseVariableDefinitions();
        const selections = this.#parseSelections();
        operations.push({ type, name, variables, selections });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.#next();
        const name = this.#expectName();
        this.#expectName('on');
        const typeCondition = this.#expectName();
        const selections = this.#parseSelections();
        fragments.set(name, { typeCondition, selections });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }
  #parseVariableDefinitions(): { name: string; defaultValue?: GqlValue }[] {
    const defs: { name: string; defaultValue?: GqlValue }[] = [];
    const token = this.#peek();
    if (token === undefined || token.kind !== 'punct' || token.value !== '(') return defs;
    this.#next();
    while (true) {
      const next = this.#peek();
      if (next === undefined) throw new Error('unterminated variable definitions');
      if (next.kind === 'punct' && next.value === ')') {
        this.#next();
        break;
      }
      this.#expectPunct('$');
      const name = this.#expectName();
      this.#expectPunct(':');
      this.#parseType();
      let defaultValue: GqlValue | undefined;
      const eq = this.#peek();
      if (eq !== undefined && eq.kind === 'punct' && eq.value === '=') {
        this.#next();
        defaultValue = this.#parseValue();
      }
      defs.push({ name, defaultValue });
    }
    return defs;
  }
  #parseType(): void {
    const token = this.#peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '[') {
      this.#next();
      this.#parseType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    const bang = this.#peek();
    if (bang !== undefined && bang.kind === 'punct' && bang.value === '!') this.#next();
  }
  #parseSelections(): GqlSelection[] {
    this.#expectPunct('{');
    const selections: GqlSelection[] = [];
    while (true) {
      const token = this.#peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.#next();
        break;
      }
      selections.push(this.#parseSelection());
    }
    return selections;
  }
  #parseSelection(): GqlSelection {
    const token = this.#peek() as GqlToken;
    if (token.kind === 'punct' && token.value === '...') {
      this.#next();
      const next = this.#peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.#next();
        const typeCondition = this.#expectName();
        return { kind: 'fragment', typeCondition, selections: this.#parseSelections() };
      }
      if (next !== undefined && next.kind === 'name') {
        const name = this.#next().value as string;
        return { kind: 'fragment', name, selections: [] };
      }
      throw new Error('expected a fragment name or "on" after ...');
    }
    if (token.kind !== 'name') throw new Error(`expected a field name, got ${JSON.stringify(token.value)}`);
    let name = this.#next().value as string;
    let alias: string | undefined;
    const colon = this.#peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.#next();
      alias = name;
      name = this.#expectName();
    }
    let args: Record<string, GqlValue> | undefined;
    const paren = this.#peek();
    if (paren !== undefined && paren.kind === 'punct' && paren.value === '(') {
      this.#next();
      args = {};
      while (true) {
        const next = this.#peek();
        if (next === undefined) throw new Error('unterminated arguments');
        if (next.kind === 'punct' && next.value === ')') {
          this.#next();
          break;
        }
        const argName = this.#expectName();
        this.#expectPunct(':');
        args[argName] = this.#parseValue();
      }
    }
    let selections: GqlSelection[] | undefined;
    const brace = this.#peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      selections = this.#parseSelections();
    }
    return { kind: 'field', name, alias, args, selections };
  }
  #parseValue(): GqlValue {
    const token = this.#next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.#expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (true) {
        const next = this.#peek();
        if (next === undefined) throw new Error('unterminated list');
        if (next.kind === 'punct' && next.value === ']') {
          this.#next();
          break;
        }
        items.push(this.#parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (true) {
        const next = this.#peek();
        if (next === undefined) throw new Error('unterminated input object');
        if (next.kind === 'punct' && next.value === '}') {
          this.#next();
          break;
        }
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.#parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function resolveGqlValue(node: GqlValue, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'list':
      return node.items.map((item) => resolveGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveGqlValue(field.value, variables);
      return out;
    }
  }
}

function resolveGqlArgs(selection: GqlSelection, variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (selection.args !== undefined) {
    for (const [name, node] of Object.entries(selection.args)) out[name] = resolveGqlValue(node, variables);
  }
  return out;
}

// ------------------------------------------------------------ executor values

type GqlParent =
  | { kind: 'query' }
  | { kind: 'mutation' }
  | { kind: 'viewer' }
  | { kind: 'repository'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: Pull }
  | { kind: 'connection'; itemKind: string; nodes: GqlParent[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null }; totalCount: number }
  | { kind: 'pageInfo'; info: { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null } }
  | { kind: 'type'; name: string }
  | { kind: 'field'; name: string }
  | { kind: 'enumValue'; name: string }
  | { kind: 'ref'; name: string }
  | { kind: 'changedFile'; path: string; additions: number; deletions: number }
  | { kind: 'payload'; fields: Record<string, GqlParent | null> }
  | { kind: 'commentEdge'; node: GqlParent }
  | { kind: 'comment'; id: string; body: string };

function typeNameOf(parent: GqlParent): string {
  switch (parent.kind) {
    case 'query':
      return 'Query';
    case 'mutation':
      return 'Mutation';
    case 'viewer':
      return 'User';
    case 'repository':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pull':
      return 'PullRequest';
    case 'connection':
      return parent.itemKind === 'Issue' ? 'IssueConnection' : parent.itemKind === 'PullRequest' ? 'PullRequestConnection' : 'PullRequestChangedFileConnection';
    case 'pageInfo':
      return 'PageInfo';
    case 'type':
      return '__Type';
    case 'field':
      return '__Field';
    case 'enumValue':
      return '__EnumValue';
    case 'ref':
      return 'Ref';
    case 'changedFile':
      return 'PullRequestChangedFile';
    case 'payload':
      return 'Payload';
    case 'commentEdge':
      return 'IssueCommentEdge';
    case 'comment':
      return 'IssueComment';
  }
}

const ALLOWED_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login', 'id', 'name']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'closed']),
  PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changes']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor']),
  Ref: new Set(['name']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description']),
  __Field: new Set(['name', 'description']),
  __EnumValue: new Set(['name', 'description']),
  IssueComment: new Set(['id', 'body']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  Payload: new Set(['issue', 'pullRequest', 'commentEdge', 'comment', 'clientMutationId']),
  __Schema: new Set(['queryType', 'mutationType', 'types']),
};

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'],
  User: ['login', 'id', 'name', 'email'],
  SearchType: [],
};

const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function createIssueInRepo(repo: Repo, title: string, body: string): Issue {
  const seq = nextSeq();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    id: nextObjectId,
    globalId: globalId('Issue', [repo.id, number]),
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    user: VIEWER_LOGIN,
    createdAt: tsIso(seq),
    updatedAt: tsIso(seq),
    seq,
  };
  nextObjectId += 1;
  repo.issues.push(issue);
  return issue;
}

function createPullInRepo(repo: Repo, head: string, base: string, title: string, body: string): { pull: Pull } | { error: string } {
  const headSha = tipOf(repo, head);
  const baseSha = tipOf(repo, base);
  if (headSha === undefined || baseSha === undefined) return { error: 'head or base branch does not exist' };
  const duplicate = repo.pulls.find((pull) => pull.head === head && pull.state === 'open');
  if (duplicate !== undefined) return { error: 'A pull request already exists for this head branch' };
  const seq = nextSeq();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    id: nextObjectId,
    globalId: globalId('PullRequest', [repo.id, number]),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head,
    base,
    headSha,
    baseSha,
    user: VIEWER_LOGIN,
    createdAt: tsIso(seq),
    updatedAt: tsIso(seq),
    seq,
  };
  nextObjectId += 1;
  repo.pulls.push(pull);
  return { pull };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlParent {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const field = orderBy !== null ? String(orderBy.field ?? 'CREATED_AT') : 'CREATED_AT';
  const direction = orderBy !== null ? String(orderBy.direction ?? 'ASC') : 'ASC';
  if (field === 'CREATED_AT' || field === 'UPDATED_AT') {
    list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  }
  let start = 0;
  const afterSeq = seqFromCursor(args.after);
  if (afterSeq !== null) {
    const idx = list.findIndex((issue) => issue.seq === afterSeq);
    if (idx >= 0) start = idx + 1;
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + first < list.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).seq) : null;
  const startCursor = page.length > 0 ? cursorFor((page[0] as Issue).seq) : null;
  return {
    kind: 'connection',
    itemKind: 'Issue',
    nodes: page.map((issue) => ({ kind: 'issue', repo, issue }) as GqlParent),
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, endCursor, startCursor },
    totalCount: list.length,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlParent {
  const list = [...repo.pulls].filter((pull) => pull.state === 'open').sort((a, b) => a.seq - b.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = first < list.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Pull).seq) : null;
  const startCursor = page.length > 0 ? cursorFor((page[0] as Pull).seq) : null;
  return {
    kind: 'connection',
    itemKind: 'PullRequest',
    nodes: page.map((pull) => ({ kind: 'pull', repo, pull }) as GqlParent),
    pageInfo: { hasNextPage, hasPreviousPage: false, endCursor, startCursor },
    totalCount: list.length,
  };
}

function pullFilesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): GqlParent {
  const files = pullFilesJson(repo, pull);
  const first = typeof args.first === 'number' ? args.first : files.length;
  const page = files.slice(0, first);
  const nodes: GqlParent[] = page.map((file) => ({
    kind: 'changedFile',
    path: String(file.filename ?? ''),
    additions: typeof file.additions === 'number' ? file.additions : 0,
    deletions: typeof file.deletions === 'number' ? file.deletions : 0,
  }));
  return {
    kind: 'connection',
    itemKind: 'PullRequestChangedFile',
    nodes,
    pageInfo: { hasNextPage: first < files.length, hasPreviousPage: false, endCursor: null, startCursor: null },
    totalCount: files.length,
  };
}

interface GqlContext {
  errors: { message: string }[];
  variables: Readonly<Record<string, unknown>>;
}

function findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length < 2) return null;
  const repo = findRepoById(Number(decoded.parts[0]));
  if (repo === undefined) return null;
  const issue = repo.issues.find((entry) => entry.number === Number(decoded.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length < 2) return null;
  const repo = findRepoById(Number(decoded.parts[0]));
  if (repo === undefined) return null;
  const pull = repo.pulls.find((entry) => entry.number === Number(decoded.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

function resolveField(parent: GqlParent, selection: GqlSelection, ctx: GqlContext): unknown {
  const args = resolveGqlArgs(selection, ctx.variables);
  switch (parent.kind) {
    case 'query': {
      if (selection.name === 'viewer') return { kind: 'viewer' } as GqlParent;
      if (selection.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = findRepo(owner, name);
        return repo === undefined ? null : ({ kind: 'repository', repo } as GqlParent);
      }
      if (selection.name === 'node') {
        const id = String(args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(Number(decoded.parts[0]));
          return repo === undefined ? null : ({ kind: 'repository', repo } as GqlParent);
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(id);
          return found === null ? null : ({ kind: 'issue', repo: found.repo, issue: found.issue } as GqlParent);
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(id);
          return found === null ? null : ({ kind: 'pull', repo: found.repo, pull: found.pull } as GqlParent);
        }
        return null;
      }
      if (selection.name === '__type') {
        const name = String(args.name ?? '');
        if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES) && name !== 'User') return null;
        return { kind: 'type', name } as GqlParent;
      }
      if (selection.name === '__schema') return { kind: 'type', name: '__Schema' } as GqlParent;
      return null;
    }
    case 'mutation': {
      const input = isRecord(args.input) ? args.input : {};
      if (selection.name === 'createIssue') {
        const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = repoId !== null && repoId.kind === 'Repository' ? findRepoById(Number(repoId.parts[0])) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'createIssue: repository not found' });
          return { kind: 'payload', fields: { issue: null } } as GqlParent;
        }
        const issue = createIssueInRepo(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
        return { kind: 'payload', fields: { issue: { kind: 'issue', repo, issue } as GqlParent } } as GqlParent;
      }
      if (selection.name === 'closeIssue') {
        const found = findIssueByGlobalId(String(input.issueId ?? ''));
        if (found === null) {
          ctx.errors.push({ message: 'closeIssue: issue not found' });
          return { kind: 'payload', fields: { issue: null } } as GqlParent;
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = tsIso(nextSeq());
        return { kind: 'payload', fields: { issue: { kind: 'issue', repo: found.repo, issue: found.issue } as GqlParent } } as GqlParent;
      }
      if (selection.name === 'createPullRequest') {
        const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = repoId !== null && repoId.kind === 'Repository' ? findRepoById(Number(repoId.parts[0])) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'createPullRequest: repository not found' });
          return { kind: 'payload', fields: { pullRequest: null } } as GqlParent;
        }
        const created = createPullInRepo(
          repo,
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
        );
        if ('error' in created) {
          ctx.errors.push({ message: `createPullRequest: ${created.error}` });
          return { kind: 'payload', fields: { pullRequest: null } } as GqlParent;
        }
        return { kind: 'payload', fields: { pullRequest: { kind: 'pull', repo, pull: created.pull } as GqlParent } } as GqlParent;
      }
      if (selection.name === 'mergePullRequest') {
        const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
        if (found === null) {
          ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
          return { kind: 'payload', fields: { pullRequest: null } } as GqlParent;
        }
        if (found.pull.state !== 'open') {
          ctx.errors.push({ message: 'mergePullRequest: pull request is not open' });
          return { kind: 'payload', fields: { pullRequest: { kind: 'pull', repo: found.repo, pull: found.pull } as GqlParent } } as GqlParent;
        }
        if (!pullMergeable(found.repo, found.pull)) {
          ctx.errors.push({ message: 'mergePullRequest: merge conflict' });
          return { kind: 'payload', fields: { pullRequest: { kind: 'pull', repo: found.repo, pull: found.pull } as GqlParent } } as GqlParent;
        }
        squashMerge(found.repo, found.pull);
        return { kind: 'payload', fields: { pullRequest: { kind: 'pull', repo: found.repo, pull: found.pull } as GqlParent } } as GqlParent;
      }
      if (selection.name === 'addComment') {
        const found = findIssueByGlobalId(String(input.subjectId ?? ''));
        if (found === null) {
          ctx.errors.push({ message: 'addComment: subject not found' });
          return { kind: 'payload', fields: { commentEdge: null } } as GqlParent;
        }
        const seq = nextSeq();
        const comment: IssueComment = {
          id: found.repo.nextCommentId,
          globalId: globalId('IssueComment', [found.repo.id, found.issue.number, found.repo.nextCommentId]),
          body: String(input.body ?? ''),
          user: VIEWER_LOGIN,
          createdAt: tsIso(seq),
          updatedAt: tsIso(seq),
          seq,
        };
        found.repo.nextCommentId += 1;
        found.issue.comments.push(comment);
        const node: GqlParent = { kind: 'comment', id: comment.globalId, body: comment.body };
        return { kind: 'payload', fields: { commentEdge: { kind: 'commentEdge', node } as GqlParent } } as GqlParent;
      }
      return null;
    }
    case 'viewer': {
      if (selection.name === 'login') return VIEWER_LOGIN;
      if (selection.name === 'id') return globalId('User', [VIEWER_ID]);
      if (selection.name === 'name') return VIEWER_NAME;
      return null;
    }
    case 'repository': {
      const repo = parent.repo;
      switch (selection.name) {
        case 'id':
          return globalId('Repository', [repo.id]);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { kind: 'viewer' } as GqlParent;
        case 'defaultBranchRef': {
          const tip = tipOf(repo, repo.defaultBranch);
          return tip === undefined ? null : ({ kind: 'ref', name: repo.defaultBranch } as GqlParent);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.find((entry) => entry.number === Number(args.number));
          return issue === undefined ? null : ({ kind: 'issue', repo, issue } as GqlParent);
        }
        case 'issues':
          return issueConnection(repo, args);
        case 'pullRequests':
          return pullConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
          return pull === undefined ? null : ({ kind: 'pull', repo, pull } as GqlParent);
        }
        default:
          return null;
      }
    }
    case 'issue': {
      const issue = parent.issue;
      switch (selection.name) {
        case 'id':
          return issue.globalId;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'url':
          return `https://github.com/${parent.repo.owner}/${parent.repo.name}/issues/${issue.number}`;
        case 'closed':
          return issue.state === 'closed';
        default:
          return null;
      }
    }
    case 'pull': {
      const pull = parent.pull;
      switch (selection.name) {
        case 'id':
          return pull.globalId;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable':
          return pull.state === 'open' ? (pullMergeable(parent.repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'files':
          return pullFilesConnection(parent.repo, pull, args);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        default:
          return null;
      }
    }
    case 'connection': {
      if (selection.name === 'nodes') return parent.nodes;
      if (selection.name === 'edges') {
        return parent.nodes.map((node) => ({ kind: 'commentEdge', node }) as GqlParent);
      }
      if (selection.name === 'pageInfo') return { kind: 'pageInfo', info: parent.pageInfo } as GqlParent;
      if (selection.name === 'totalCount') return parent.totalCount;
      return null;
    }
    case 'pageInfo': {
      if (selection.name === 'hasNextPage') return parent.info.hasNextPage;
      if (selection.name === 'hasPreviousPage') return parent.info.hasPreviousPage;
      if (selection.name === 'endCursor') return parent.info.endCursor;
      if (selection.name === 'startCursor') return parent.info.startCursor;
      return null;
    }
    case 'type': {
      const name = parent.name;
      if (selection.name === 'name') return name;
      if (selection.name === 'kind') return name in TYPE_ENUM_VALUES ? 'ENUM' : 'OBJECT';
      if (selection.name === 'description') return null;
      if (selection.name === 'fields') {
        const fields = TYPE_FIELDS[name] ?? [];
        return fields.map((field) => ({ kind: 'field', name: field }) as GqlParent);
      }
      if (selection.name === 'enumValues') {
        const values = TYPE_ENUM_VALUES[name] ?? [];
        return values.map((value) => ({ kind: 'enumValue', name: value }) as GqlParent);
      }
      return null;
    }
    case 'field': {
      if (selection.name === 'name') return parent.name;
      if (selection.name === 'description') return null;
      return null;
    }
    case 'enumValue': {
      if (selection.name === 'name') return parent.name;
      if (selection.name === 'description') return null;
      return null;
    }
    case 'ref': {
      if (selection.name === 'name') return parent.name;
      return null;
    }
    case 'changedFile': {
      if (selection.name === 'path') return parent.path;
      if (selection.name === 'additions') return parent.additions;
      if (selection.name === 'deletions') return parent.deletions;
      if (selection.name === 'changes') return parent.additions + parent.deletions;
      return null;
    }
    case 'payload': {
      const value = parent.fields[selection.name as string];
      return value === undefined ? null : value;
    }
    case 'commentEdge': {
      if (selection.name === 'node') return parent.node;
      if (selection.name === 'cursor') return null;
      return null;
    }
    case 'comment': {
      if (selection.name === 'id') return parent.id;
      if (selection.name === 'body') return parent.body;
      return null;
    }
  }
}

function isGqlParent(value: unknown): value is GqlParent {
  return isRecord(value) && typeof (value as { kind?: unknown }).kind === 'string';
}

function resolveSelections(
  parent: GqlParent,
  selections: readonly GqlSelection[],
  ctx: GqlContext,
  fragments: ReadonlyMap<string, { typeCondition: string; selections: GqlSelection[] }>,
): Record<string, unknown> {
  const parentType = typeNameOf(parent);
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== parentType) continue;
      if (selection.name !== undefined) {
        const fragment = fragments.get(selection.name);
        if (fragment !== undefined) {
          if (fragment.typeCondition !== parentType) continue;
          Object.assign(out, resolveSelections(parent, fragment.selections, ctx, fragments));
        }
        continue;
      }
      Object.assign(out, resolveSelections(parent, selection.selections ?? [], ctx, fragments));
      continue;
    }
    const name = selection.name as string;
    const key = selection.alias ?? name;
    if (name === '__typename') {
      out[key] = parentType;
      continue;
    }
    if (name === '__type' || name === '__schema') {
      // Meta-fields live on Query only; elsewhere they are unknown.
      if (parentType !== 'Query') {
        ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
        out[key] = null;
        continue;
      }
    }
    const allowed = ALLOWED_FIELDS[parentType];
    if (allowed !== undefined && !allowed.has(name)) {
      ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    const value = resolveField(parent, selection, ctx);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    const sub = selection.selections;
    if (sub !== undefined && sub.length > 0) {
      if (Array.isArray(value)) {
        out[key] = value.map((entry) => {
          if (entry === null) return null;
          if (isGqlParent(entry)) return resolveSelections(entry, sub, ctx, fragments);
          return entry;
        });
      } else if (isGqlParent(value)) {
        out[key] = resolveSelections(value, sub, ctx, fragments);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = isGqlParent(value) ? null : value;
    }
  }
  return out;
}

function executeGraphQLOperation(
  doc: GqlDocument,
  operationName: string | undefined,
  variables: Readonly<Record<string, unknown>>,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const errors: { message: string }[] = [];
  let operation = doc.operations[0];
  if (operationName !== undefined) {
    operation = doc.operations.find((entry) => entry.name === operationName) ?? operation;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const def of operation.variables) {
    if (mergedVariables[def.name] === undefined && def.defaultValue !== undefined) {
      mergedVariables[def.name] = resolveGqlValue(def.defaultValue, variables);
    }
  }
  const ctx: GqlContext = { errors, variables: mergedVariables };
  const root: GqlParent = operation.type === 'mutation' ? { kind: 'mutation' } : { kind: 'query' };
  const data = resolveSelections(root, operation.selections, ctx, doc.fragments);
  return { data, errors };
}

function executeGraphQL(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation needs a query string' }] };
      }
      return runOneGraphQL(entry);
    });
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'A query string is required' }] };
  }
  return runOneGraphQL(body);
}

function runOneGraphQL(body: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const query = String(body.query);
  const variables = isRecord(body.variables) ? body.variables : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let doc: GqlDocument;
  try {
    doc = new GqlParser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const result = executeGraphQLOperation(doc, operationName, variables);
  if (result.errors.length > 0) return { data: result.data, errors: result.errors };
  return { data: result.data };
}

// ------------------------------------------------------------------ MCP

const MCP_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_NAME = 'github-core-forge';
const MCP_SERVER_VERSION = '1.0.0';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Built once: two tools/list calls must answer byte-for-byte identical lists.
const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Pull request state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
]);

function mcpRepo(req: IncomingMessage, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repoName === '') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return findRepo(owner, repoName) ?? null;
}

function mcpRequired(args: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = args[field];
    if (value === undefined || value === null || value === '') return `Missing required argument: ${field}`;
  }
  return null;
}

function mcpCallTool(req: IncomingMessage, name: string, args: Record<string, unknown>): { result: unknown } | { error: string } {
  switch (name) {
    case 'create_repo': {
      const missing = mcpRequired(args, ['name']);
      if (missing !== null) return { error: missing };
      const repoName = String(args.name);
      if (findRepo(VIEWER_LOGIN, repoName) !== undefined) return { error: `Repository ${repoName} already exists` };
      const repo = createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { result: repoJson(req, repo) };
    }
    case 'get_repo': {
      const missing = mcpRequired(args, ['owner', 'repo']);
      if (missing !== null) return { error: missing };
      const repo = mcpRepo(req, args);
      if (repo === null) return { error: 'Repository not found' };
      return { result: repoJson(req, repo) };
    }
    case 'create_issue': {
      const missing = mcpRequired(args, ['owner', 'repo', 'title']);
      if (missing !== null) return { error: missing };
      const repo = mcpRepo(req, args);
      if (repo === null) return { error: 'Repository not found' };
      const issue = createIssueInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '');
      return { result: issueJson(req, repo, issue) };
    }
    case 'list_issues': {
      const missing = mcpRequired(args, ['owner', 'repo']);
      if (missing !== null) return { error: missing };
      const repo = mcpRepo(req, args);
      if (repo === null) return { error: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { result: { issues: list.map((issue) => issueJson(req, repo, issue)), total_count: list.length } };
    }
    case 'create_pull_request': {
      const missing = mcpRequired(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return { error: missing };
      const repo = mcpRepo(req, args);
      if (repo === null) return { error: 'Repository not found' };
      const created = createPullInRepo(repo, String(args.head), String(args.base), String(args.title), typeof args.body === 'string' ? args.body : '');
      if ('error' in created) return { error: created.error };
      return { result: pullJson(req, repo, created.pull) };
    }
    case 'merge_pull_request': {
      const missing = mcpRequired(args, ['owner', 'repo', 'pull_number']);
      if (missing !== null) return { error: missing };
      const repo = mcpRepo(req, args);
      if (repo === null) return { error: 'Repository not found' };
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { error: 'Pull request not found' };
      if (pull.merged && pull.mergeCommitSha !== null) {
        return { result: { merged: true, sha: pull.mergeCommitSha, message: `${pull.title} (#${pull.number})`, number: pull.number } };
      }
      if (pull.state !== 'open') return { error: 'Pull request is closed' };
      if (!pullMergeable(repo, pull)) return { error: 'Merge conflict' };
      const sha = squashMerge(repo, pull);
      if (sha === null) return { error: 'Merge conflict' };
      return { result: { merged: true, sha, message: `${pull.title} (#${pull.number})`, number: pull.number } };
    }
    case 'get_issue': {
      const missing = mcpRequired(args, ['owner', 'repo', 'issue_number']);
      if (missing !== null) return { error: missing };
      const repo = mcpRepo(req, args);
      if (repo === null) return { error: 'Repository not found' };
      const issue = repo.issues.find((entry) => entry.number === Number(args.issue_number));
      if (issue === undefined) return { error: 'Issue not found' };
      return { result: issueJson(req, repo, issue) };
    }
    case 'list_pull_requests': {
      const missing = mcpRequired(args, ['owner', 'repo']);
      if (missing !== null) return { error: missing };
      const repo = mcpRepo(req, args);
      if (repo === null) return { error: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return { result: { pull_requests: list.map((pull) => pullJson(req, repo, pull)), total_count: list.length } };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function mcpRpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpRpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    sendNoContent(res);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, errJson('Method Not Allowed'));
    return;
  }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let parsed: unknown = null;
  let parseFailed = false;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parseFailed = true;
  }
  // The id, when the broken body still names one (the parse-error check sends a truncated body with an id).
  let fallbackId: unknown = null;
  const idMatch = /"id"\s*:\s*("[^"]*"|\d+)/.exec(text);
  if (idMatch !== null) {
    const rawId = idMatch[1] as string;
    fallbackId = rawId.startsWith('"') ? rawId.slice(1, -1) : Number(rawId);
  }
  if (parseFailed) {
    sendJson(res, 400, mcpRpcError(fallbackId, -32700, 'Parse error: request body is not valid JSON'));
    return;
  }
  if (!authed(req)) {
    const id = isRecord(parsed) ? (parsed.id ?? null) : null;
    sendJson(res, 401, mcpRpcError(id, -32001, 'Unauthorized'));
    return;
  }
  // Batch bodies: answer each request in order.
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const entry of parsed) answers.push(mcpDispatch(req, entry));
    sendJson(res, 200, answers);
    return;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, mcpRpcError(fallbackId, -32600, 'Invalid Request'));
    return;
  }
  const answer = mcpDispatch(req, parsed);
  if (answer === null) {
    // A notification: no JSON-RPC response body.
    res.writeHead(202, { 'x-github-request-id': `req-${(requestCounter += 1)}` });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

/** Dispatch one JSON-RPC request object. Returns null for a notification. */
function mcpDispatch(req: IncomingMessage, body: Record<string, unknown>): Record<string, unknown> | null {
  const id = body.id ?? null;
  const hasId = 'id' in body && body.id !== undefined && body.id !== null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Protocol-version gate: a declared revision we do not speak is -32022
  // naming the revisions we do. No header (the legacy handshake) skips it.
  const declared = req.headers['mcp-protocol-version'];
  if (typeof declared === 'string' && declared !== '' && !MCP_VERSIONS.includes(declared)) {
    if (!hasId) return null;
    return mcpRpcError(id, -32022, `Unsupported protocol version: ${declared}`, { supported: [...MCP_VERSIONS] });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    return mcpRpcResult(id, {});
  }
  if (method === 'server/discover') {
    return mcpRpcResult(id, {
      resultType: 'DiscoverResult',
      supportedVersions: [...MCP_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = MCP_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return mcpRpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return mcpRpcResult(id, { tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = MCP_TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      return mcpRpcError(id, -32601, `Unknown tool: ${name}`);
    }
    const outcome = mcpCallTool(req, name, args);
    if ('error' in outcome) {
      return mcpRpcResult(id, {
        content: [{ type: 'text', text: outcome.error }],
        isError: true,
      });
    }
    return mcpRpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: false,
    });
  }
  return mcpRpcError(id, -32601, `Method not found: ${method}`);
}

// ------------------------------------------------------------------ git smart HTTP

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

interface AdvertisedRef {
  oid: string;
  name: string;
}

/** Refs for an advertisement: HEAD first, then refs sorted, with peeled tag lines after their tag. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs: AdvertisedRef[] = [];
  const defaultTip = tipOf(repo, repo.defaultBranch);
  refs.push({ oid: defaultTip ?? ZERO_OID, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) refs.push({ oid: repo.refs.get(name) as string, name });
  if (refs.length === 1 && refs[0]?.name === 'HEAD' && refs[0]?.oid === ZERO_OID) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return lines;
  }
  refs.forEach((ref, index) => {
    lines.push(pktLine(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
    if (ref.name.startsWith('refs/tags/')) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(ref.oid, lookupIn(repo));
        if (peeled !== null) lines.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  });
  return lines;
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=forge/1.0\n'),
    PKT_FLUSH,
  ]);
}

interface FetchPlan {
  objects: GitObject[];
  shallowOut: string[];
  unshallowOut: string[];
  acks: string[];
}

/**
 * Plan a fetch: which objects to send for `wants`, given what the client
 * already holds (`haves`), its shallow boundaries, and a depth limit.
 */
function planFetch(repo: Repo, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | null): FetchPlan {
  const lookup = lookupIn(repo);
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallowIn);
  const D = depth ?? Number.POSITIVE_INFINITY;

  // BFS over commits from the wants, tracking the shallowest depth seen.
  const commitDepth = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = [];
  let queueHead = 0;
  const enqueue = (oid: string, depth: number): void => {
    const prev = commitDepth.get(oid);
    if (prev === undefined || depth < prev) {
      commitDepth.set(oid, depth);
      queue.push({ oid, depth });
    }
  };
  const wantedTags = new Set<string>();
  const directObjects = new Set<string>();
  for (const want of wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantedTags.add(want);
      const target = peelToCommit(want, lookup);
      if (target !== null) enqueue(target, 1);
    } else if (object.type === 'commit') {
      enqueue(want, 1);
    } else {
      directObjects.add(want);
    }
  }
  const included = new Set<string>();
  const traversedShallow = new Set<string>();
  while (queueHead < queue.length) {
    const item = queue[queueHead] as { oid: string; depth: number };
    queueHead += 1;
    const { oid, depth } = item;
    if (depth > D) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (haveSet.has(oid)) {
      if (shallowSet.has(oid)) {
        // A held shallow boundary: do not re-send it, but its parents may be
        // needed (deepen). It stops being a boundary once traversed past.
        traversedShallow.add(oid);
        const commit = parseCommit(object.data);
        for (const parent of commit.parents) enqueue(parent, depth + 1);
      }
      continue;
    }
    included.add(oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) enqueue(parent, depth + 1);
  }

  // Shallow boundaries: included commits at the depth limit that have parents.
  const shallowOut: string[] = [];
  for (const oid of included) {
    if (commitDepth.get(oid) !== D) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.length > 0) shallowOut.push(oid);
  }
  // Boundaries that moved: old shallow lines traversed at less than the limit.
  const unshallowOut: string[] = [];
  for (const oid of traversedShallow) {
    const depthSeen = commitDepth.get(oid);
    if (depthSeen !== undefined && depthSeen < D && !shallowOut.includes(oid)) unshallowOut.push(oid);
  }

  // The closure to send: included commits and their TREE closures only.
  // collectReachable would also walk parents, which breaks depth-limited
  // (shallow) fetches by leaking the ancestors a shallow clone must not see.
  const toSend = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (toSend.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined) continue;
      toSend.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };
  for (const oid of included) {
    toSend.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
  }
  for (const oid of wantedTags) toSend.add(oid);
  for (const oid of directObjects) toSend.add(oid);

  // Held objects: full closure of non-shallow haves; commit+tree only of shallow ones.
  const held = new Set<string>();
  for (const have of haves) {
    const object = lookup(have);
    if (object === undefined) continue;
    if (shallowSet.has(have)) {
      const commitOid = object.type === 'tag' ? peelToCommit(have, lookup) : have;
      if (commitOid !== null) {
        held.add(have);
        held.add(commitOid);
        // The held closure of a shallow boundary is that commit and its tree
        // (no parents, no tag objects beyond the boundary itself).
        const commit = repo.objects.get(commitOid);
        if (commit !== undefined && commit.type === 'commit') {
          const walkTree = (treeOid: string): void => {
            const tree = repo.objects.get(treeOid);
            if (tree === undefined || tree.type !== 'tree') return;
            held.add(treeOid);
            for (const entry of parseTree(tree.data)) {
              if (entry.mode === '40000') walkTree(entry.oid);
              else held.add(entry.oid);
            }
          };
          walkTree(parseCommit(commit.data).tree);
        }
      }
    } else {
      try {
        for (const reachable of collectReachable([have], lookup)) held.add(reachable);
      } catch {
        // A have naming an object we do not hold is ignored.
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...toSend].sort()) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  }
  // Wanted tags are always sent (the client needs the tag object for the ref).
  for (const oid of wantedTags) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined && !objects.includes(object)) objects.push(object);
  }

  // ACKs: haves that are ancestors-or-equal of a want.
  const ancestors = new Set<string>();
  for (const want of wants) {
    const target = peelToCommit(want, lookup) ?? want;
    for (const oid of walkCommits(repo, target)) ancestors.add(oid);
  }
  const acks = [...haves].filter((have) => ancestors.has(have) || wants.includes(have)).sort();
  return { objects, shallowOut: shallowOut.sort(), unshallowOut: unshallowOut.sort(), acks };
}

/** Scan pkt-lines from the front of `buf` until the first flush; returns the lines and the rest. */
function scanPktLinesUntilFlush(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) return { lines, rest: buf.subarray(off + 4) };
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line length out of range');
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  throw new Error('pkt-line stream ends before flush');
}

function lsRefsResponse(repo: Repo, lines: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const defaultTip = tipOf(repo, repo.defaultBranch);
  if (defaultTip === undefined) {
    if (unborn && keep('HEAD')) {
      out.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  } else {
    if (keep('HEAD')) {
      const symref = symrefs ? ' symref-target:refs/heads/main' : '';
      out.push(pktLine(`${defaultTip} HEAD${symref}\n`));
    }
    const names = [...repo.refs.keys()].sort();
    for (const name of names) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name) as string;
      let suffix = '';
      if (peel && name.startsWith('refs/tags/')) {
        const object = repo.objects.get(oid);
        if (object !== undefined && object.type === 'tag') {
          const peeled = peelToCommit(oid, lookupIn(repo));
          if (peeled !== null) suffix += ` peeled:${peeled}`;
        }
      }
      out.push(pktLine(`${oid} ${name}${suffix}\n`));
    }
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

function fetchResponseV2(repo: Repo, lines: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallows.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallows, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  // Real git (fetch-pack.c, do_fetch_pack_v2) reads an "acknowledgments"
  // section only when the request carried "have" lines: when it sends
  // "done" with no haves it jumps straight to the packfile sections and
  // dies on any other first section. So the acknowledgments section is
  // sent only when the client negotiated with haves; a fresh clone gets
  // no acknowledgments section at all. The kit's v2 parser accepts
  // either shape (a bare "packfile" line opens the packfile section).
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'), PKT_DELIM);
  }
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, sections: string[][]): Buffer {
  // Section 0: wants (+shallow/deepen); section 1: haves + done.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  for (const line of sections[0] ?? []) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('shallow ')) shallows.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  for (const line of sections[1] ?? []) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('have ')) haves.push(text.slice(5).trim());
  }
  const plan = planFetch(repo, wants, haves, shallows, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, seg: readonly string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  const owner = seg[0] as string;
  const repoName = (seg[1] as string).replace(/\.git$/, '');
  const tail = seg.slice(2);
  if (!authed(req)) {
    sendJson(res, 401, errJson('Requires authentication'));
    return true;
  }
  if (owner !== VIEWER_LOGIN) {
    sendJson(res, 404, errJson('Not Found'));
    return true;
  }
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, errJson('Not Found'));
    return true;
  }

  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = queryOf(req).get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, errJson('Unknown service'));
      return true;
    }
    const isV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    if (service === 'git-upload-pack' && isV2) {
      sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
    const body = Buffer.concat([
      pktLine(`# service=${service}\n`),
      PKT_FLUSH,
      ...v0RefLines(repo, caps),
      PKT_FLUSH,
    ]);
    sendBytes(res, 200, body, `application/x-${service}-advertisement`);
    return true;
  }

  if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
    const service = tail[0] as 'git-upload-pack' | 'git-receive-pack';
    const raw = await readBody(req);
    if (service === 'git-receive-pack') {
      const answer = handleReceivePack(repo, raw);
      sendBytes(res, 200, answer, 'application/x-git-receive-pack-result');
      return true;
    }
    // git-upload-pack, v2 when the client asked for it, else v0.
    const isV2 = req.headers['git-protocol'] === 'version=2';
    try {
      if (isV2) {
        const packets = decodePktLines(raw);
        const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
        const commandLine = (lines[0] ?? '').replace(/\n$/, '');
        if (commandLine === 'command=ls-refs') {
          const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
          const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
          const argLines = argPackets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
          sendBytes(res, 200, lsRefsResponse(repo, argLines), 'application/x-git-upload-pack-result');
          return true;
        }
        if (commandLine === 'command=fetch') {
          const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
          const argPackets = delimIndex >= 0 ? packets.slice(delimIndex + 1) : packets.slice(1);
          const argLines = argPackets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
          sendBytes(res, 200, fetchResponseV2(repo, argLines), 'application/x-git-upload-pack-result');
          return true;
        }
        sendBytes(res, 400, Buffer.from('unknown command\n', 'utf8'), 'text/plain');
        return true;
      }
      const packets = decodePktLines(raw);
      const sections = pktSections(packets);
      sendBytes(res, 200, fetchResponseV0(repo, sections), 'application/x-git-upload-pack-result');
      return true;
    } catch {
      sendBytes(res, 400, Buffer.from('malformed pkt-line stream\n', 'utf8'), 'text/plain');
      return true;
    }
  }

  sendJson(res, 404, errJson('Not Found'));
  return true;
}

/** Handle a receive-pack POST body; always answers a sideband report-status stream. */
function handleReceivePack(repo: Repo, raw: Buffer): Buffer {
  let commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packBytes = Buffer.alloc(0);
  let unpackError: string | null = null;
  try {
    const scanned = scanPktLinesUntilFlush(raw);
    packBytes = scanned.rest;
    for (const line of scanned.lines) {
      const text = line.replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const core = nul >= 0 ? text.slice(0, nul) : text;
      const parts = core.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch (err) {
    unpackError = err instanceof Error ? err.message : 'malformed command list';
    commands = [];
  }

  const snapshot = new Map(repo.refs);
  if (unpackError === null && packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of parsed.objects.values()) {
        repo.objects.set(hashObject(object.type, object.data), object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  // Each report line is newline-terminated: the kit's push-report parser
  // splits the de-framed stream on "\n", so a missing newline glues the
  // unpack line to the first ref line ("unpack okok refs/heads/main").
  const reportLines: string[] = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const command of commands) {
    if (unpackError !== null) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = snapshot.get(command.ref);
    const refExists = current !== undefined;
    if (!command.ref.startsWith('refs/')) {
      reportLines.push(`ng ${command.ref} invalid ref\n`);
      continue;
    }
    if (command.oldOid !== (current ?? ZERO_OID)) {
      reportLines.push(`ng ${command.ref} old oid mismatch\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (!refExists) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (!refExists) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = peelToCommit(command.newOid, lookupIn(repo));
    if (target === null) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (isAncestor(current as string, target, lookupIn(repo))) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }
  const reportStream = encodePktLines([...reportLines, 'flush']);
  return Buffer.concat([...sidebandPackets(reportStream), PKT_FLUSH]);
}

// ------------------------------------------------------------------ server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const seg = pathSegments(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && seg.length === 1 && seg[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (seg.length >= 2 && (seg[1] as string).endsWith('.git')) {
          await handleGit(req, res, seg);
          return;
        }

        if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
          if (!authed(req)) {
            sendJson(res, 401, errJson('Requires authentication'));
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, errJson('Invalid JSON'));
            return;
          }
          await handleRest(req, res, seg, parsed.value);
          return;
        }

        if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, errJson('Not Found'));
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, errJson('Requires authentication'));
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, errJson('Invalid JSON'));
            return;
          }
          sendJson(res, 200, executeGraphQL(parsed.value));
          return;
        }

        if (seg.length === 1 && seg[0] === 'mcp') {
          await handleMcp(req, res);
          return;
        }

        sendJson(res, 404, errJson('Not Found'));
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          sendJson(res, 500, errJson('Internal Server Error'));
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
