/**
 * dh-common — shared workspace-path and delegation helpers for the
 * dh-multiagents bundle.
 *
 * Every project-scoped helper confines filesystem access to
 * `$DSH_HOME/workspace/<projectId>/`: caller-supplied project ids are parsed at
 * the tool boundary (Parse-Don't-Validate) and every joined path is resolved
 * and asserted to stay under the workspace root before it can reach the fs.
 *
 * @module @dh-multiagents/dh-common
 */

import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
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

/** The resolved project directory under the workspace root (confined). */
export function projectDir(projectId: string): string {
  const root = workspaceRoot()
  const dir = resolve(root, parseProjectId(projectId))
  if (!isWithin(root, dir)) {
    throw new Error(`projectId ${JSON.stringify(projectId)} escapes $DSH_HOME/workspace`)
  }
  return dir
}

/**
 * Resolve `target` against `baseDir` and reject any result that escapes it.
 * Absolute targets inside `baseDir` are allowed; absolute or relative targets
 * that resolve outside are rejected.
 */
export function confinePath(baseDir: string, target: string): string {
  const resolved = resolve(baseDir, target)
  if (!isWithin(baseDir, resolved)) {
    throw new Error(`path ${JSON.stringify(target)} escapes ${baseDir}`)
  }
  return resolved
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
