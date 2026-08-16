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

/** The project id: explicit param, else the basename of the session cwd. */
export function projectIdOf(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  return basename(cwd)
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
 * segment, and the resolved workspace-relative path must stay under
 * `$DSH_HOME/workspace`.
 */
export function parseProjectId(input: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(input)) {
    throw new Error(`projectId must match ^[A-Za-z0-9._-]+$, got ${JSON.stringify(input)}`)
  }
  const root = workspaceRoot()
  if (!isWithin(root, resolve(root, input))) {
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
 * Resolve `target` against `baseDir` and reject any result that escapes it.
 * Absolute targets inside `baseDir` are allowed; absolute or relative targets
 * that resolve outside are rejected. The result is realpath-canonicalized so a
 * planted symlink inside the workspace cannot redirect the read outside.
 */
export function confinePath(baseDir: string, target: string): string {
  const realBase = realpathSync(baseDir)
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
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    real = join(realpathSync(dirname(candidate)), basename(candidate))
  }
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

/** Read an agent's persisted delegation depth; absence means top-level. */
export function delegationDepthOf(agent: {
  readonly session: { readonly header: { readonly delegationDepth?: number } }
}): number {
  return agent.session.header.delegationDepth ?? 0
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

/** A context that carries a scoped tools registry (an agent's `agent.ctx`). */
export interface ScopedAgentCtxLike {
  readonly tools: ToolRegistryLike
  /** Optional scoped logger (`ctx.logger`), used to warn on foreign presets. */
  readonly logger?: { warn(message: string): void }
}

/**
 * Enforce one preset's capability matrix on an agent scope: keep exactly the
 * preset's ALLOW-list of global tools and hide every other global tool.
 *
 * A preset outside `CAPABILITY_MATRIX` passes through UNRESTRICTED: a foreign
 * preset (harness-shipped names like `standard`, `code`, `minimal`, `cordis`,
 * or anything dh-multiagents does not own) is governed by its owning
 * deployment, not by this bundle, so it is logged as a warning and left with
 * its full toolset instead of being rejected. Only a preset WE define with an
 * empty allow-list fails loud (an empty filter would hide every tool, which is
 * almost always a configuration bug). Returns the restriction disposer for
 * symmetric teardown; a foreign preset yields a no-op disposer.
 *
 * @param agentCtx - the agent's scoped context (`agent.ctx`); must be scoped,
 *   because a context-global restriction would mask every agent.
 * @param presetName - one of the `CAPABILITY_MATRIX` keys, or a foreign preset
 *   name that passes through unrestricted.
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
  return agentCtx.tools.restrict({ allow })
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
