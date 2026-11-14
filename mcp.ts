// mcp.ts — github-forge-v2's Model Context Protocol endpoint: JSON-RPC 2.0 over streamable HTTP,
// speaking the modern 2026-07-28 revision (server/discover, no handshake) and the legacy handshake
// (initialize + notifications/initialized). The tool list is one constant array, so two tools/list
// calls answer byte for byte. The six tools act on the same store as REST.

import { Forge, VIEWER, type RepoRec } from './store.ts';
import { issueShape, pullShape, repoShape } from './shapes.ts';

export const MCP_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string; title: string; description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

function tool(name: string, title: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, title, description, inputSchema: { type: 'object', properties, required } };
}

const OWNER_PROP = { type: 'string', description: 'The repository owner login.' };
const REPO_PROP = { type: 'string', description: 'The repository name.' };

export const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create repository', 'Create a new repository owned by the authenticated user.',
    { name: { type: 'string', description: 'The repository name.' }, description: { type: 'string', description: 'A short description.' }, private: { type: 'boolean', description: 'Whether the repository is private.' } },
    ['name']),
  tool('get_repo', 'Get repository', 'Read one repository by owner and name.',
    { owner: OWNER_PROP, repo: REPO_PROP }, ['owner', 'repo']),
  tool('create_issue', 'Create issue', 'Open a new issue in a repository.',
    { owner: OWNER_PROP, repo: REPO_PROP, title: { type: 'string', description: 'The issue title.' }, body: { type: 'string', description: 'The issue body.' } },
    ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues', 'List the issues of a repository, optionally filtered by state.',
    { owner: OWNER_PROP, repo: REPO_PROP, state: { type: 'string', description: 'open, closed or all.' } },
    ['owner', 'repo']),
  tool('create_pull_request', 'Create pull request', 'Open a pull request from a head branch into a base branch.',
    { owner: OWNER_PROP, repo: REPO_PROP, title: { type: 'string', description: 'The pull request title.' }, head: { type: 'string', description: 'The head branch.' }, base: { type: 'string', description: 'The base branch.' }, body: { type: 'string', description: 'The pull request body.' } },
    ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge pull request', 'Merge a pull request by number (squash).',
    { owner: OWNER_PROP, repo: REPO_PROP, pull_number: { type: 'integer', description: 'The pull request number.' } },
    ['owner', 'repo', 'pull_number']),
]);

const TOOL_BY_NAME = new Map(TOOLS.map((definition) => [definition.name, definition]));

interface JsonRpcRequest { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }

function resultResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

/** Handle one parsed JSON-RPC request; returns the response object, or null for a notification. */
export function handleMcp(forge: Forge, request: JsonRpcRequest): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;
  if (method === 'server/discover') {
    return resultResponse(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-forge-v2', version: '1.0.0' },
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-forge-v2', version: '1.0.0' } },
    });
  }
  if (method === 'initialize') {
    const params = request.params ?? {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : MCP_REVISION;
    return resultResponse(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-forge-v2', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return null;
  if (method === 'ping') return resultResponse(id, {});
  if (method === 'tools/list') return resultResponse(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const params = request.params ?? {};
    const name = typeof params.name === 'string' ? params.name : '';
    const definition = TOOL_BY_NAME.get(name);
    if (!definition) return errorResponse(id, -32602, `unknown tool: ${name}`);
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    for (const required of definition.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return errorResponse(id, -32602, `missing required argument: ${required}`);
      }
    }
    try {
      return resultResponse(id, callTool(forge, name, args));
    } catch (err) {
      return resultResponse(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }
  if (isNotification) return null;
  return errorResponse(id, -32601, `method not found: ${method}`);
}

function repoOf(forge: Forge, args: Record<string, unknown>): RepoRec {
  const owner = stringArg(args, 'owner') || VIEWER.login;
  const repoName = stringArg(args, 'repo');
  const repo = forge.getRepo(owner, repoName);
  if (!repo) throw new Error(`repository not found: ${owner}/${repoName}`);
  return repo;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (!repoName) throw new Error('missing required argument: name');
      if (forge.getRepo(VIEWER.login, repoName)) throw new Error(`repository already exists: ${repoName}`);
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolResult(repoShape(forge, repo));
    }
    case 'get_repo': {
      const repo = repoOf(forge, args);
      return toolResult(repoShape(forge, repo));
    }
    case 'create_issue': {
      const repo = repoOf(forge, args);
      const issue = forge.createIssue(repo, stringArg(args, 'title'), stringArg(args, 'body'), []);
      return toolResult(issueShape(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = repoOf(forge, args);
      const state = stringArg(args, 'state') || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueShape(forge, repo, issue));
      return toolResult({ total_count: issues.length, items: issues, issues });
    }
    case 'create_pull_request': {
      const repo = repoOf(forge, args);
      const pull = forge.createPull(repo, stringArg(args, 'title'), stringArg(args, 'body'), stringArg(args, 'head'), stringArg(args, 'base') || repo.defaultBranch);
      return toolResult(pullShape(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoOf(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) throw new Error(`pull request not found: ${number}`);
      const sha = forge.mergePull(repo, pull);
      if (!sha) throw new Error(`pull request ${number} cannot be merged (conflict)`);
      return toolResult({ ...pullShape(forge, repo, pull), sha, merged: true, message: 'Pull Request successfully merged' });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
