/**
 * dh-common — shared workspace-path, capability-matrix, and delegation helpers
 * for the dh-multiagents bundle.
 *
 * Every project-scoped helper confines filesystem access to
 * `$DSH_HOME/workspace/<projectId>/`: caller-supplied project ids are parsed at
 * the tool boundary (Parse-Don't-Validate), every joined path is resolved and
 * realpath-canonicalized, and asserted to stay under the workspace root before
 * it can reach the fs. The capability matrix maps each agent preset to its
 * ALLOW-list of global tool names and enforces it per agent scope.
 *
 * @module @dh-multiagents/dh-common
 */

import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

// ---------------------------------------------------------------------------
// Workspace paths
// ---------------------------------------------------------------------------

/** Resolve `$DSH_HOME`, falling back to `~/.dsh` when unset. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Fallback project id when the session cwd yields no usable name. */
const DEFAULT_PROJECT_ID = 'workspace'

/**
 * Coerce a cwd basename into a safe single-segment project id: characters
 * outside `[A-Za-z0-9._-]` become `-` (collapsed and trimmed), and a result
 * that is empty or resolves to `.`/`..` falls back to {@link DEFAULT_PROJECT_ID}
 * so an unusual cwd never crashes `parseProjectId` downstream.
 */
function safeProjectIdFromBasename(cwdName: string): string {
  const sanitized = cwdName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (sanitized === '' || sanitized === '.' || sanitized === '..') {
    return DEFAULT_PROJECT_ID
  }
  return sanitized
}

/** The project id: explicit param, else the sanitized basename of the session cwd. */
export function projectIdOf(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  return safeProjectIdFromBasename(basename(cwd))
}

/** The confined workspace root (`$DSH_HOME/workspace`). */
export function workspaceRoot(): string {
  return resolve(join(dshHome(), 'workspace'))
}

/**
 * Ensure the workspace root exists and return its realpath. Canonicalizing the
 * root at the boundary means every path derived from it is compared against
 * the same physical location a symlink resolves to, so a planted link cannot
 * smuggle a path outside the container.
 */
function realWorkspaceRoot(): string {
  const root = workspaceRoot()
  mkdirSync(root, { recursive: true })
  return realpathSync(root)
}

/**
 * Boundary parser for a caller-supplied project id. Rejects anything that
 * could traverse out of the workspace root: the id must be a single safe path
 * segment that names a real subdirectory — empty, `.`/`..`, and anything
 * resolving to the workspace root itself are refused, and the resolved
 * workspace-relative path must stay strictly under `$DSH_HOME/workspace`.
 */
export function parseProjectId(input: string): string {
  if (input.trim() === '') {
    throw new Error(`projectId must not be empty, got ${JSON.stringify(input)}`)
  }
  if (input === '.' || input === '..') {
    throw new Error(`projectId ${JSON.stringify(input)} does not name a project directory under $DSH_HOME/workspace`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(input)) {
    throw new Error(`projectId must match ^[A-Za-z0-9._-]+$, got ${JSON.stringify(input)}`)
  }
  const root = workspaceRoot()
  const resolved = resolve(root, input)
  if (resolved === root || !isWithin(root, resolved)) {
    throw new Error(`projectId ${JSON.stringify(input)} resolves outside $DSH_HOME/workspace`)
  }
  return input
}

/** The resolved project directory under the workspace root (confined, realpath-canonicalized). */
export function projectDir(projectId: string): string {
  const root = realWorkspaceRoot()
  const dir = resolve(root, parseProjectId(projectId))
  if (!isWithin(root, dir)) {
    throw new Error(`projectId ${JSON.stringify(projectId)} escapes $DSH_HOME/workspace`)
  }
  return realpathWithin(root, dir, `projectId ${JSON.stringify(projectId)}`)
}

/**
 * Canonicalize `path` even when it (or any ancestor) does not exist yet: walk
 * up to the deepest existing ancestor, realpath it, and re-append the missing
 * tail lexically. A not-yet-existing leaf cannot be a link, so its real path
 * is its lexical path under the real ancestor.
 */
function realpathLoose(path: string): string {
  const missing: string[] = []
  let candidate = path
  for (;;) {
    try {
      const real = realpathSync(candidate)
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    } catch {
      const parent = dirname(candidate)
      if (parent === candidate) return resolve(path)
      missing.push(basename(candidate))
      candidate = parent
    }
  }
}

/**
 * Resolve `target` against `baseDir` and reject any result that escapes it.
 * Absolute targets inside `baseDir` are allowed; absolute or relative targets
 * that resolve outside are rejected. The result is realpath-canonicalized so a
 * planted symlink inside the workspace cannot redirect the read outside.
 */
export function confinePath(baseDir: string, target: string): string {
  const realBase = realpathLoose(baseDir)
  const resolved = resolve(realBase, target)
  if (!isWithin(realBase, resolved)) {
    throw new Error(`path ${JSON.stringify(target)} escapes ${baseDir}`)
  }
  return realpathWithin(realBase, resolved, `path ${JSON.stringify(target)}`)
}

/**
 * Canonicalize `candidate` under an already-real `base` and reject a symlink
 * that escapes. A not-yet-existing leaf keeps its lexical name inside the real
 * base: it cannot be a link, and its deepest existing ancestor is real already.
 */
function realpathWithin(base: string, candidate: string, label: string): string {
  const real = realpathLoose(candidate)
  if (!isWithin(base, real)) {
    throw new Error(`${label} escapes ${base} through a symlink`)
  }
  return real
}

/** Whether `candidate` is `base` itself or strictly inside it. */
function isWithin(base: string, candidate: string): boolean {
  const rel = relative(base, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// ---------------------------------------------------------------------------
// Error and agent helpers
// ---------------------------------------------------------------------------

/** Extract a safe single-line message from an unknown error. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Read an agent's delegation depth: the persisted header value, deepened by
 * any runtime subagent-depth override (the option can only ever deepen the
 * count, never lower it). Absence of both means top-level.
 */
export function delegationDepthOf(agent: {
  readonly session: { readonly header: { readonly delegationDepth?: number } }
  readonly options?: unknown
}): number {
  const runtimeDepth = (agent.options as { readonly subagentDepth?: number } | undefined)?.subagentDepth ?? 0
  return Math.max(agent.session.header.delegationDepth ?? 0, runtimeDepth)
}

// ---------------------------------------------------------------------------
// Capability matrix (per-preset tool allow-lists)
// ---------------------------------------------------------------------------

/**
 * The per-agent capability matrix: each preset's ALLOW-list of global tool
 * names. Every name was verified against the deployment's actual global
 * toolset (`bash, create_goal, delegate, delegation_list, delegation_read,
 * edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent, job_kill,
 * job_list, job_output, list_agents, plan_read, plan_save, ralph, read,
 * read_image, send_message, skill, str_replace_editor, subagent,
 * subagent_fork, todo_write, update_goal, web_search, workflow,
 * worktree_create, worktree_delete, write`).
 *
 * Deliberately excluded from EVERY preset: the incidental tools `ralph`,
 * `workflow`, and `job_*` (job_kill/job_list/job_output) are not part of the
 * dh-multiagents orchestration model. `web_fetch` is absent from the deployed
 * global toolset (only `web_search` exists), so `researcher` lists
 * `web_search` only.
 */
export const CAPABILITY_MATRIX: Readonly<Record<string, readonly string[]>> = {
  /** Read-only plan orchestrator: writes plans, delegates research/exploration, drives goals. */
  plan: [
    'plan_save', 'plan_read',
    'delegate', 'delegation_read', 'delegation_list',
    'subagent', 'subagent_fork',
    'send_message', 'interrupt_agent', 'list_agents',
    'skill', 'todo_write',
    'create_goal', 'get_goal', 'update_goal', 'exit_plan_mode',
  ],
  /** Read-only build orchestrator: delegates builders, isolates work with worktrees. */
  build: [
    'delegate', 'delegation_read', 'delegation_list',
    'subagent', 'subagent_fork',
    'send_message', 'interrupt_agent', 'list_agents',
    'worktree_create', 'worktree_delete',
    'skill', 'todo_write',
  ],
  /** Read-only codebase explorer: reads, searches, and inspects only. */
  explore: ['read', 'glob', 'grep', 'read_image'],
  /** Read-only external researcher: web search plus file reads. */
  researcher: ['web_search', 'read', 'glob', 'grep'],
  /** Write-capable implementer: edits, runs code, manages worktrees. */
  coder: [
    'bash', 'edit', 'write', 'read', 'glob', 'grep', 'read_image',
    'str_replace_editor',
    'worktree_create', 'worktree_delete',
    'skill', 'todo_write',
  ],
  /** Documentation writer: edits and writes docs, reads back. */
  scribe: ['edit', 'write', 'read'],
  /** Read-only reviewer: reads, searches, and inspects only. */
  reviewer: ['read', 'glob', 'grep'],
}

/** The global-tool restriction the dsh harness accepts (mirrors `ToolRestriction`). */
export interface ToolRestrictionLike {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

/** The tools-registry surface `restrictPresetTools` needs (a scoped agent context). */
export interface ToolRegistryLike {
  restrict(filter: ToolRestrictionLike): () => void
}

/**
 * The dsh-tools registry scope-view surface read by `restrictPresetTools`.
 * `ToolRuntime.view` is declared `private` in dsh-tools (a compile-time-only
 * modifier), so `ToolRegistryLike` cannot name it without breaking the real
 * `ToolRuntime`'s structural assignability; it is read here through a narrow
 * cast. `view(undefined)` yields the GLOBAL toolset's `restrictableNames` (the
 * set of names `restrict()` accepts).
 */
interface ToolScopeViewLike {
  view?(scope: unknown): { readonly restrictableNames: ReadonlySet<string> } | undefined
}

/** A context that carries a scoped tools registry (an agent's `agent.ctx`). */
export interface ScopedAgentCtxLike {
  readonly tools: ToolRegistryLike
  /** Optional scoped logger (`ctx.logger`), used to warn on foreign presets. */
  readonly logger?: { warn(message: string): void }
}

/**
 * Applies the capability-matrix restriction for a known preset to `agentCtx.tools`.
 *
 * The matrix allow-list is filtered against the tools this deployment exposes as
 * GLOBAL (and therefore restrictable). Names that exist only in the agent's own
 * scope layer (per-agent registrations) are not restrictable — `tools.restrict()`
 * would throw on them — so they are skipped with a warning instead of aborting
 * child creation. Foreign presets pass through unrestricted. A matrix entry with
 * an empty allow-list is a configuration bug and still throws. A preset whose
 * allow-list is entirely non-restrictable degrades to a warning and no restriction
 * (hiding every tool would be worse than leaving the toolset unrestricted).
 */
export function restrictPresetTools(agentCtx: ScopedAgentCtxLike, presetName: string): () => void {
  const allow = CAPABILITY_MATRIX[presetName]
  if (allow === undefined) {
    agentCtx.logger?.warn(
      `dh-common: preset ${JSON.stringify(presetName)} is outside the capability matrix; `
      + 'leaving its toolset unrestricted (foreign presets are governed by their owning deployment)',
    )
    return () => {}
  }
  if (allow.length === 0) {
    throw new Error(
      `dh-common: preset ${JSON.stringify(presetName)} has an empty allow-list; `
      + 'refusing to hide every global tool (capability matrix is misconfigured)',
    )
  }
  const restrictable = (agentCtx.tools as unknown as ToolScopeViewLike).view?.(undefined)?.restrictableNames
  if (restrictable === undefined) {
    // Older harness without a scope view: preserve prior behavior, but never crash child creation.
    try {
      return agentCtx.tools.restrict({ allow })
    } catch (error) {
      agentCtx.logger?.warn(`dh-common: preset ${presetName} restriction failed (${errorMessage(error)}); leaving its toolset unrestricted`)
      return () => {}
    }
  }
  const enforced = allow.filter((name) => restrictable.has(name))
  const skipped = allow.filter((name) => !restrictable.has(name))
  if (skipped.length > 0) {
    agentCtx.logger?.warn(`dh-common: preset ${presetName} skipped ${skipped.length} tool(s) that are not restrictable in this deployment (agent-local, not global): ${skipped.join(', ')}; the rest of the matrix is still enforced`)
  }
  if (enforced.length === 0) {
    agentCtx.logger?.warn(`dh-common: preset ${presetName} has no restrictable tools in this deployment; leaving its toolset unrestricted rather than hiding every tool`)
    return () => {}
  }
  try {
    return agentCtx.tools.restrict({ allow: enforced })
  } catch (error) {
    agentCtx.logger?.warn(`dh-common: preset ${presetName} restriction failed (${errorMessage(error)}); leaving its toolset unrestricted`)
    return () => {}
  }
}

// ---------------------------------------------------------------------------
// Assistant output selection
// ---------------------------------------------------------------------------

/** Structural content block used by the shared output selectors. */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: unknown
  readonly [key: string]: unknown
}

/** Structural session event subset the output selectors read. */
export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

/** The harness's canonical final-output selection (last non-empty assistant message). */
export function finalAssistantOutput(
  events: readonly SessionEventLike[],
): readonly ContentBlockLike[] | undefined {
  let message: readonly ContentBlockLike[] | undefined
  const partial: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = (event.data as
        | { readonly message?: { readonly content?: readonly ContentBlockLike[] } }
        | undefined)?.message?.content
      if (content !== undefined && content.length > 0) message = content
    } else if (event.type === 'assistant/chunk') {
      const chunk = (event.data as
        | { readonly chunk?: { readonly type?: string; readonly text?: unknown } }
        | undefined)?.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        partial.push(chunk.text)
      }
    }
  }
  if (message !== undefined) return message
  const text = partial.join('')
  return text.length > 0 ? [{ type: 'text', text }] : undefined
}

// ---------------------------------------------------------------------------
// Readable delegation ids
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  'swift', 'quiet', 'brave', 'golden', 'lively', 'calm', 'bright', 'nimble',
  'steady', 'clever', 'crisp', 'daring', 'eager', 'fierce', 'gentle', 'honest',
  'jolly', 'keen', 'lucent', 'mellow', 'noble', 'proud', 'radiant', 'silent',
  'witty',
] as const

const COLORS = [
  'amber', 'azure', 'coral', 'emerald', 'indigo', 'lilac', 'ruby', 'teal',
  'violet', 'bronze', 'cerulean', 'gold', 'jade', 'lavender', 'onyx', 'pearl',
  'saffron', 'topaz',
] as const

const ANIMALS = [
  'fox', 'otter', 'falcon', 'heron', 'lynx', 'badger', 'finch', 'mantis',
  'owl', 'koala', 'beaver', 'crane', 'dove', 'elk', 'gazelle', 'hawk', 'ibis',
  'jay', 'kiwi', 'lark', 'marten', 'newt', 'panda', 'quail', 'raven', 'stoat',
  'vireo',
] as const

function pick(values: readonly string[]): string {
  return values[Math.floor(Math.random() * values.length)] ?? values[0] ?? 'unknown'
}

/** Mint a readable delegation id in the form `adjective-color-animal`. */
export function readableDelegationId(): string {
  return `${pick(ADJECTIVES)}-${pick(COLORS)}-${pick(ANIMALS)}`
}
