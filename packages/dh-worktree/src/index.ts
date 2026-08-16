/**
 * dh-worktree — git worktree management for the dh-multiagents bundle.
 *
 * Registers `worktree_create` / `worktree_delete`, running `git` through the
 * subprocess seam and persisting the created worktrees under
 * `$DSH_HOME/workspace/<projectId>/worktrees.json`.
 *
 * @module @dh-multiagents/dh-worktree
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseProjectId, projectDir, projectIdOf } from '@dh-multiagents/dh-common'

export const name = 'dh-worktree'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Local structural types for the subprocess seam
// ---------------------------------------------------------------------------

interface SubprocessCollect {
  readonly maxBytes: number
  readonly spill?: { readonly maxBytes: number }
}

interface SubprocessHandle {
  readonly pid: number
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
  readonly collected: {
    readonly stdout?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
    readonly stderr?: { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } }
  }
  terminate(): void
}

interface SubprocessRuntime {
  spawn(spec: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly stdio: {
      readonly stdin: 'ignore' | 'pipe' | { readonly data: string }
      readonly stdout: 'pipe' | 'inherit' | SubprocessCollect
      readonly stderr: 'pipe' | 'inherit' | SubprocessCollect
    }
    readonly graceMs: number
    readonly signal?: AbortSignal
  }): SubprocessHandle
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function worktreesFile(projectId: string): string {
  return join(projectDir(projectId), 'worktrees.json')
}

function worktreesDir(projectId: string): string {
  return join(projectDir(projectId), 'worktrees')
}

/**
 * Names accepted by `git check-ref-format --branch`: no leading "-", ".", "@",
 * or "/"; no "..", "@{", "//", spaces, control bytes, or any of ~ ^ : ? * [ \;
 * no component ending in "." or ".lock"; at least one character.
 */
const BRANCH_NAME_PATTERN = /^(?![-.@\/])(?!.*\.\.)(?!.*@\{)(?!.*[\x00-\x20\x7f~^:?*[\\])(?!.*\/(?:\/|$))(?!.*\.lock(?:\/|$))(?!.*\.(?:\/|$))[a-zA-Z0-9._/-]+$/

/** Throw unless `branch` is a name git would accept for a new branch. */
function assertBranchName(branch: string): void {
  if (!BRANCH_NAME_PATTERN.test(branch)) {
    throw new Error(
      `worktree_create: "${branch}" is not a valid git branch name. `
      + 'It must not start with "-", ".", "@", or "/"; must not contain "..", '
      + '"@{", "//", spaces, control bytes, or any of ~ ^ : ? * [ \\; and must not end with "." or "/".',
    )
  }
}

/** Throw unless `baseBranch` can safely be passed to git and resolves to a commit. */
async function assertResolvableBaseBranch(
  ctx: Context,
  cwd: string,
  baseBranch: string,
  signal: AbortSignal,
): Promise<void> {
  if (baseBranch.startsWith('-')) {
    throw new Error(
      `worktree_create: baseBranch "${baseBranch}" looks like a git option; pass a branch or commit name instead`,
    )
  }
  try {
    await runGit(ctx, cwd, ['rev-parse', '--verify', `${baseBranch}^{commit}`], signal)
  } catch {
    throw new Error(
      `worktree_create: baseBranch "${baseBranch}" does not resolve to a commit in this repository`,
    )
  }
}

/** Make a branch name safe to use as a single path component. */
function pathSafe(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '-')
  // "." and ".." would make the worktree path escape the worktrees directory.
  return sanitized === '.' || sanitized === '..' || sanitized.length === 0 ? 'worktree' : sanitized
}

/**
 * Best-effort removal of `directory` when it exists and is empty. Pre-existing
 * non-empty directories (and plain files) are never touched.
 */
async function removeEmptyDirectory(directory: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    // Missing, a file, or unreadable — nothing safe to remove.
    return
  }
  if (entries.length === 0) {
    await rm(directory, { recursive: false, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Git execution through the subprocess seam
// ---------------------------------------------------------------------------

interface GitResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run `git` in `cwd`, collecting both streams, and fail loud on non-zero exit. */
async function runGit(
  ctx: Context,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<GitResult> {
  // Do not execute an already-aborted call.
  signal.throwIfAborted()
  const subprocess = ctx.get('subprocess') as unknown as SubprocessRuntime
  const handle = subprocess.spawn({
    argv: ['git', ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 10_000,
    signal,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed (exit ${outcome.exitCode ?? 'signal'}): ${stderr.trim()}`)
  }
  return { exitCode: outcome.exitCode, stdout, stderr }
}

// ---------------------------------------------------------------------------
// Worktree state persistence
// ---------------------------------------------------------------------------

interface WorktreeEntry {
  readonly path: string
  readonly branch: string
  readonly baseBranch?: string
  readonly createdAt: string
}

/** Read the persisted worktree state; a missing file is an empty list. */
async function readWorktrees(projectId: string): Promise<WorktreeEntry[]> {
  const file = worktreesFile(projectId)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (isMissing(error)) return []
    throw error
  }
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`dh-worktree: state file ${file} is malformed (expected an array)`)
  }
  return parsed as WorktreeEntry[]
}

async function writeWorktrees(projectId: string, entries: readonly WorktreeEntry[]): Promise<void> {
  const file = worktreesFile(projectId)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(entries, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'worktree_create',
    description: 'Create a git worktree isolated from the main checkout, '
      + 'persisting its state under $DSH_HOME/workspace/<projectId>/worktrees.json.',
    parameters: {
      branch: { type: 'string', description: 'Branch name for the new worktree (defaults to dsh/<random>); must not exist yet' },
      baseBranch: { type: 'string', description: 'Base branch/commit the new branch starts from (defaults to the current branch)' },
      projectId: { type: 'string', description: 'Project id (defaults to the basename of the session working directory)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          branch: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `worktree created at ${value.path} on branch ${value.branch}` }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const projectId = parseProjectId(args.projectId ?? projectIdOf(exec))
      // Fail loud outside a git work tree.
      await runGit(ctx, cwd, ['rev-parse', '--is-inside-work-tree'], exec.signal)

      const branch = args.branch ?? `dsh/${randomBranchSuffix()}`
      const baseBranch = args.baseBranch === '' ? undefined : args.baseBranch

      // Parse model-provided names at the boundary so an injected value can
      // never be interpreted as a git option or forwarded to git unverified.
      assertBranchName(branch)
      if (baseBranch !== undefined) {
        await assertResolvableBaseBranch(ctx, cwd, baseBranch, exec.signal)
      }

      const path = join(worktreesDir(projectId), pathSafe(branch))
      await mkdir(dirname(path), { recursive: true })
      const argv = ['worktree', 'add', '-b', branch, path, ...(baseBranch !== undefined ? [baseBranch] : [])]
      try {
        await runGit(ctx, cwd, argv, exec.signal)
      } catch (error) {
        // Do not leave an empty worktree directory behind when git rejects the
        // branch or base ref. Pre-existing non-empty directories are preserved.
        await removeEmptyDirectory(path)
        throw error
      }

      const entry: WorktreeEntry = {
        path,
        branch,
        ...baseBranch !== undefined ? { baseBranch } : {},
        createdAt: new Date().toISOString(),
      }
      const entries = await readWorktrees(projectId)
      await writeWorktrees(projectId, [...entries, entry])
      return { path, branch }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'worktree_delete',
    description: 'Remove a git worktree. Refuses to remove a worktree with uncommitted '
      + 'changes unless a reason is given (which authorizes the forced removal).',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute path of the worktree to remove' },
      reason: { type: 'string', description: 'Required to force-remove a worktree with uncommitted changes' },
      projectId: { type: 'string', description: 'Project id (defaults to the basename of the session working directory)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `worktree removed: ${value.path}` }],
    },
    async execute(args, exec) {
      const projectId = parseProjectId(args.projectId ?? projectIdOf(exec))
      // Fail loud when the path does not look like a tracked worktree.
      const entries = await readWorktrees(projectId)
      const tracked = entries.find(entry => entry.path === args.path)
      if (tracked === undefined) {
        throw new Error(
          `worktree_delete: unknown worktree path "${args.path}"; delete only paths recorded in ${worktreesFile(projectId)}`,
        )
      }

      const status = await runGit(ctx, args.path, ['status', '--porcelain'], exec.signal)
      if (status.stdout.trim().length > 0 && args.reason === undefined) {
        throw new Error(
          'worktree_delete: the worktree has uncommitted changes and was not removed. '
          + 'Commit or stash them, or call worktree_delete again with a `reason` to force the removal.',
        )
      }

      // Run the removal from the session cwd (the main checkout), not from
      // inside the worktree being removed.
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      await runGit(ctx, cwd, ['worktree', 'remove', '--force', args.path], exec.signal)
      await writeWorktrees(projectId, entries.filter(entry => entry.path !== args.path))
      return { path: args.path, removed: true }
    },
  }))
}

/** Whether an fs error means the path simply does not exist. */
function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT'
}

/** A short random suffix for default branch names. */
function randomBranchSuffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
