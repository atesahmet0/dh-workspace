/**
 * dh-delegation — async delegation tools for the dh-multiagents bundle.
 *
 * Registers `delegate`, `delegation_read`, and `delegation_list`. A delegation
 * is persisted immediately as `$DSH_HOME/workspace/<projectId>/delegations/<id>.md`
 * (readable id `adjective-color-animal`), and children run through the
 * `dh-subagent-preset` providers: explore/researcher/reviewer one-shot,
 * coder/scribe continuable. Delegation from inside a subagent is rejected
 * (anti-recursion).
 *
 * @module @dh-multiagents/dh-delegation
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  confinePath,
  delegationDepthOf,
  errorMessage,
  finalAssistantOutput,
  parseProjectId,
  projectDir,
  projectIdOf,
  readableDelegationId,
} from '@dh-multiagents/dh-common'
import type { ContentBlockLike } from '@dh-multiagents/dh-common'

export const name = 'dh-delegation'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Local structural types (the subagent seam and its lifecycle events)
// ---------------------------------------------------------------------------

type AgentLike = NonNullable<ToolRunContext['agent']>
type SessionIdBrand = AgentLike['session']['header']['id']

interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: readonly ContentBlockLike[]
  readonly parent: AgentLike
  readonly signal: AbortSignal
  readonly agentOptions?: AgentLike['options']
  readonly maxDepth?: number
  readonly toolFilter?: { allow?: string[]; deny?: string[] }
  readonly persona?: string
}

interface SubagentRun {
  readonly id: SessionIdBrand
  readonly localAgent: AgentLike | undefined
  readonly result: Promise<{ readonly output: readonly ContentBlockLike[]; readonly stopReason: string }>
  dispose(): Promise<void>
}

interface SubagentRuntime {
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
  startContinuable(spec: {
    readonly provider: string
    readonly label: string
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
    readonly signal: AbortSignal
  }): Promise<{ readonly childId: SessionIdBrand; readonly messageId: unknown }>
  list(): string[]
}

/** Payload of the scope-filtered `subagent/end` lifecycle event. */
interface SubagentEndInfo {
  readonly runId: string
  readonly provider: string
  readonly id: string
  readonly local: boolean
  readonly stopReason: string
  readonly lastAssistantMessage?: readonly ContentBlockLike[]
}

// The harness's real seam declares this event with a scoped `this` receiver:
//   'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
// (`Scoped` lives in @deepseek-ai/dsh-scope and `SubagentRuntime`/`SubagentRunEndInfo`
// in @deepseek-ai/dsh-subagent; see the dsh-reference clone's
// packages/subagent/subagent/src/index.ts). Neither type is importable from this
// package's dependency graph, so `SubagentEndInfo` (a structural match of
// `SubagentRunEndInfo`) stands in and the `this` receiver is dropped.
// TODO: re-sync this augmentation with the harness seam once those types are importable.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'subagent/end'(info: SubagentEndInfo): void
  }
}

// ---------------------------------------------------------------------------
// Delegation vocabulary
// ---------------------------------------------------------------------------

type DelegationAgent = 'explore' | 'researcher' | 'coder' | 'scribe' | 'reviewer'

const DELEGATION_AGENTS: readonly DelegationAgent[] = [
  'explore',
  'researcher',
  'coder',
  'scribe',
  'reviewer',
]

/** One-shot providers; the rest (coder/scribe) are continuable. */
function isOneShot(agent: DelegationAgent): boolean {
  return agent === 'explore' || agent === 'researcher' || agent === 'reviewer'
}

/**
 * The delegatable roles per caller preset, mirroring the routing expressed in
 * dh-workspace's PLAN_RULES / BUILD_RULES. A read-only preset must not be able
 * to spawn a write-capable child, so the caller's composed preset is checked at
 * the tool boundary before any child starts.
 */
const DELEGATION_ROLES_BY_CALLER_PRESET: Readonly<Record<string, readonly DelegationAgent[]>> = {
  plan: ['explore', 'researcher'],
  build: ['explore', 'researcher', 'coder', 'scribe', 'reviewer'],
}

/** The agent-preset roster surface this plugin reads (mirrors @deepseek-ai/dsh-agent-presets). */
interface AgentPresets {
  composedPreset(agentCtx: Context): string | undefined
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function delegationsDir(projectId: string): string {
  return join(projectDir(projectId), 'delegations')
}

function resultFileFor(projectId: string, id: string): string {
  return join(delegationsDir(projectId), `${id}.result.txt`)
}

// ---------------------------------------------------------------------------
// Delegation records
// ---------------------------------------------------------------------------

interface DelegationRecord {
  readonly id: string
  readonly agent: string
  readonly prompt: string
  readonly status: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly resultPath: string
  readonly childId: string
}

/** Render the record markdown (frontmatter + prompt/result bodies). */
function renderRecordMarkdown(record: DelegationRecord, result: string): string {
  return [
    '---',
    `id: ${record.id}`,
    `agent: ${record.agent}`,
    `status: ${record.status}`,
    `startedAt: ${record.startedAt}`,
    `updatedAt: ${record.updatedAt}`,
    `resultPath: ${record.resultPath}`,
    `childId: ${record.childId}`,
    '---',
    '',
    '## Prompt',
    '',
    record.prompt,
    '',
    '## Result',
    '',
    result,
    '',
  ].join('\n')
}

/** Write the record markdown (frontmatter + prompt/result bodies) and the result file. */
async function writeRecord(projectId: string, record: DelegationRecord, result: string): Promise<void> {
  const dir = delegationsDir(projectId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${record.id}.md`), renderRecordMarkdown(record, result), 'utf8')
  await writeFile(record.resultPath, result, 'utf8')
}

/**
 * Create the delegation record atomically: the `.md` file is created with the
 * exclusive `wx` flag, so a concurrent caller that mints the same id fails with
 * `EEXIST` instead of silently overwriting the record.
 */
async function createRecord(projectId: string, record: DelegationRecord): Promise<void> {
  const dir = delegationsDir(projectId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${record.id}.md`), renderRecordMarkdown(record, ''), {
    encoding: 'utf8',
    flag: 'wx',
  })
  try {
    await writeFile(record.resultPath, '', 'utf8')
  } catch (error: unknown) {
    // A `running` `.md` with no result file is a stale orphan; unlink it
    // best-effort so `mintDelegationRecord`'s EEXIST retry loop never leaves
    // it behind, then rethrow so the collision check still sees this failure.
    await unlink(join(dir, `${record.id}.md`)).catch(() => {})
    throw error
  }
}

/**
 * Mint a readable delegation id by creating its record atomically. On an
 * `EEXIST` collision (another concurrent delegation won the id) a fresh id is
 * retried, so creation is race-free without a check-then-act window.
 */
async function mintDelegationRecord(
  projectId: string,
  makeRecord: (id: string) => DelegationRecord,
): Promise<DelegationRecord> {
  for (;;) {
    const id = readableDelegationId()
    const record = makeRecord(id)
    try {
      await createRecord(projectId, record)
      return record
    } catch (error: unknown) {
      // Another concurrent delegation won this id; loop and mint a fresh one.
      if (!isFileExists(error)) throw error
    }
  }
}

/** Read a delegation record and its result file; fails loud on an unknown id. */
async function readRecord(
  projectId: string,
  id: string,
): Promise<{ record: DelegationRecord; result: string; recordPath: string }> {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`delegation_read: invalid delegation id ${JSON.stringify(id)}`)
  }
  const recordPath = join(delegationsDir(projectId), `${id}.md`)
  let text: string
  try {
    text = await readFile(recordPath, 'utf8')
  } catch {
    throw new Error(`delegation_read: unknown delegation id "${id}" (no record at ${recordPath})`)
  }
  const record = parseRecord(text)
  let result = ''
  try {
    // Confine the record's result path before reading: a crafted record file
    // must not be able to point the read outside the project's delegations dir.
    result = await readFile(confinePath(delegationsDir(projectId), record.resultPath), 'utf8')
  } catch {
    result = ''
  }
  return { record, result, recordPath }
}

/** Parse the record frontmatter (single-line fields) plus its body sections. */
function parseRecord(text: string): DelegationRecord {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (frontmatter === null) {
    throw new Error('delegation record is malformed (missing frontmatter)')
  }
  const fields = new Map<string, string>()
  for (const line of (frontmatter[1] ?? '').split('\n')) {
    const sep = line.indexOf(': ')
    if (sep <= 0) continue
    fields.set(line.slice(0, sep), line.slice(sep + 2))
  }
  const required = ['id', 'agent', 'status', 'startedAt', 'updatedAt', 'resultPath', 'childId'] as const
  for (const key of required) {
    if (!fields.has(key)) {
      throw new Error(`delegation record is malformed (missing "${key}")`)
    }
  }
  return {
    id: fields.get('id') ?? '',
    agent: fields.get('agent') ?? '',
    prompt: bodySection(text, 'Prompt'),
    status: fields.get('status') ?? '',
    startedAt: fields.get('startedAt') ?? '',
    updatedAt: fields.get('updatedAt') ?? '',
    resultPath: fields.get('resultPath') ?? '',
    childId: fields.get('childId') ?? '',
  }
}

/** Extract one `## Heading` body from the record markdown. */
function bodySection(text: string, heading: string): string {
  const pattern = new RegExp(`## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |\\n---|$)`)
  const match = pattern.exec(text)
  return match?.[1]?.trim() ?? ''
}

async function updateRecordStatus(projectId: string, id: string, status: string, result: string): Promise<void> {
  const current = await readRecord(projectId, id)
  await writeRecord(projectId, { ...current.record, status, updatedAt: new Date().toISOString() }, result)
}

// ---------------------------------------------------------------------------
// Child helpers
// ---------------------------------------------------------------------------

/**
 * Buffered observer for `subagent/end` lifecycle events. Events are captured
 * the moment they fire — before any awaited child-start or record write — so
 * an early settlement can never be missed, then reconciled against the child
 * id once `startContinuable` has returned it. The buffer is pruned to the
 * known child id as soon as `waitFor` learns it, so unrelated children's
 * payloads are not retained for the watcher's lifetime.
 */
interface SubagentEndWatcher {
  /** Resolve once `subagent/end` fires for `childId`, draining any buffered event. */
  waitFor(childId: string, signal?: AbortSignal): Promise<SubagentEndInfo>
  /** Stop observing and reject every still-pending wait. */
  dispose(): void
}

/**
 * Verified `subagent/end` runtime semantics, so the per-turn assumption is not
 * reintroduced:
 *
 * - The event fires exactly ONCE per residency epoch, at that epoch's terminal
 *   disposal — never at an ordinary turn boundary. A resident epoch can run
 *   many turns and still emit a single `subagent/end`.
 * - `info.id` is the persistent child session id and equals the `childId`
 *   returned by `startContinuable`; `info.runId` is a per-epoch identifier.
 * - A later `followup` after disposal cold-resumes a NEW epoch that emits a
 *   SECOND `subagent/end` with the same `id` but a new `runId`. This watcher
 *   disposes after the first end, so the delegation record correctly reflects
 *   the first epoch's result.
 * - `stopReason !== 'completed'` (e.g. `max-tokens`, `aborted`, `refusal`,
 *   `error`) still permits a later cold-resume; only `completed` means the
 *   child will do no further work unless sent more.
 */
function watchSubagentEnds(ctx: Context): SubagentEndWatcher {
  const buffered = new Map<string, SubagentEndInfo>()
  const pending = new Map<string, {
    readonly resolve: (info: SubagentEndInfo) => void
    readonly reject: (error: Error) => void
  }>()
  // The watcher tracks one child per delegation. Until its id is known the
  // listener buffers every end event so a fast-settling child is never missed;
  // once known (first `waitFor`), unrelated buffered payloads are pruned and
  // further non-matching events are dropped.
  let knownChildId: string | undefined
  const off = ctx.on('subagent/end', (info) => {
    if (knownChildId !== undefined && info.id !== knownChildId) return
    const waiter = pending.get(info.id)
    if (waiter !== undefined) {
      pending.delete(info.id)
      waiter.resolve(info)
    } else {
      buffered.set(info.id, info)
    }
  })
  return {
    waitFor(childId, signal) {
      knownChildId = childId
      for (const id of buffered.keys()) {
        if (id !== childId) buffered.delete(id)
      }
      return new Promise<SubagentEndInfo>((resolve, reject) => {
        let settled = false
        const rejectOnce = (error: Error): void => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          pending.delete(childId)
          reject(error)
        }
        const onAbort = (): void => {
          rejectOnce(new Error(`delegate: waiting for subagent "${childId}" was aborted`))
        }
        const resolveOnce = (info: SubagentEndInfo): void => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolve(info)
        }
        if (signal?.aborted === true) {
          onAbort()
          return
        }
        const already = buffered.get(childId)
        if (already !== undefined) {
          buffered.delete(childId)
          resolveOnce(already)
          return
        }
        pending.set(childId, { resolve: resolveOnce, reject: rejectOnce })
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    dispose() {
      off()
      for (const [childId, waiter] of pending) {
        waiter.reject(new Error(`delegate: waiting for subagent "${childId}" was cancelled`))
      }
      pending.clear()
    },
  }
}

/** Render content blocks to plain text for persistence. */
function renderBlocks(blocks: readonly ContentBlockLike[]): string {
  return blocks.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return String(block.text ?? '')
    return JSON.stringify(block)
  }).join('\n')
}

/** Enrich a running delegation with the live child's latest output, if any. */
async function liveOutputOf(ctx: Context, childId: string): Promise<string> {
  const child = ctx.agents.get(childId as unknown as SessionIdBrand)
  if (child === undefined) return ''
  return renderBlocks(finalAssistantOutput(child.session.events) ?? [])
}

/** Normalize a stop reason into a record status. */
function statusOf(stopReason: string): string {
  return stopReason === 'completed' ? 'completed' : stopReason
}

/**
 * Run one fire-and-forget finalizer. Every failure is contained (logged, never
 * rethrown), so background settlement can never leave an unhandled rejection
 * that crashes the host.
 */
function runFinalizer(ctx: Context, label: string, work: () => Promise<void>): void {
  void (async () => {
    try {
      await work()
    } catch (error: unknown) {
      ctx.logger.warn(`dh-delegation: ${label} failed: ${errorMessage(error)}`)
    }
  })()
}

/**
 * Stamp a terminal status on a sync delegation whose awaited child promise
 * rejected, so the record never stays `running`. A failure to stamp is logged,
 * never raised: the original child error is the one that must propagate.
 */
async function persistSyncFailure(
  ctx: Context,
  projectId: string,
  id: string,
  signal: AbortSignal,
  error: unknown,
): Promise<void> {
  const status = signal.aborted ? 'aborted' : 'error'
  try {
    await updateRecordStatus(projectId, id, status, errorMessage(error))
  } catch (updateError: unknown) {
    ctx.logger.warn(
      `dh-delegation: could not persist status "${status}" for delegation "${id}": ${errorMessage(updateError)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'delegate',
    description: 'Start a subagent for one named role. Returns a readable delegation id '
      + '(adjective-color-animal) and persists a record under '
      + '$DSH_HOME/workspace/<projectId>/delegations/<id>.md. '
      + 'explore/researcher/reviewer are one-shot; coder/scribe are continuable. '
      + 'Delegation is forbidden from inside a subagent.',
    parameters: {
      agent: {
        type: 'string',
        enum: [...DELEGATION_AGENTS],
        required: true,
        description: 'Subagent role: explore, researcher, coder, scribe, or reviewer',
      },
      prompt: { type: 'string', required: true, description: 'Task description for the subagent' },
      mode: { type: 'string', enum: ['async', 'sync'], description: 'async returns immediately; sync waits for the result' },
      projectId: { type: 'string', description: 'Project id (defaults to the basename of the session working directory)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          agent: { type: 'string', required: true },
          status: { type: 'string', required: true },
          resultPath: { type: 'string', required: true },
          output: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.output.length > 0
          ? `delegation ${value.id} (${value.agent}) ${value.status}:\n${value.output}`
          : `delegation ${value.id} (${value.agent}) ${value.status}; result at ${value.resultPath}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('delegate: no owning agent for this call; delegation requires an agent session')
      }
      if (delegationDepthOf(parent) > 0) {
        throw new Error('delegate: delegation from within a subagent is forbidden (anti-recursion); delegate only from a top-level session')
      }

      // Privilege boundary: a read-only preset must not spawn write-capable
      // children. The caller's composed preset fixes the delegatable roles.
      const presets = parent.ctx.get('agentPresets') as AgentPresets | undefined
      const callerPreset = presets?.composedPreset(parent.ctx)
      const allowedRoles = callerPreset === undefined
        ? undefined
        : DELEGATION_ROLES_BY_CALLER_PRESET[callerPreset]
      if (allowedRoles === undefined) {
        throw new Error(
          `delegate: preset ${callerPreset === undefined ? '<none>' : JSON.stringify(callerPreset)} may not delegate; `
          + 'only the "plan" and "build" presets may delegate',
        )
      }
      if (!allowedRoles.includes(args.agent)) {
        throw new Error(
          `delegate: preset "${callerPreset}" may delegate only to ${allowedRoles.join(', ')}; `
          + `role "${args.agent}" is not allowed (refusing privilege escalation)`,
        )
      }

      const subagents = ctx.get('subagents') as SubagentRuntime | undefined
      if (subagents === undefined) {
        throw new Error('delegate: the subagents service is not composed; delegation is unavailable')
      }
      const projectId = parseProjectId(args.projectId ?? projectIdOf(exec))
      const label = args.prompt.length > 80 ? `${args.prompt.slice(0, 80)}…` : args.prompt
      const startedAt = new Date().toISOString()
      const mode = args.mode ?? 'async'
      const promptBlocks: readonly ContentBlockLike[] = [{ type: 'text', text: args.prompt }]

      const makeDelegationRecord = (id: string, childId: SessionIdBrand): DelegationRecord => ({
        id,
        agent: args.agent,
        prompt: args.prompt,
        status: 'running',
        startedAt,
        updatedAt: startedAt,
        resultPath: resultFileFor(projectId, id),
        childId,
      })

      if (isOneShot(args.agent)) {
        const run = await subagents.start(args.agent, {
          label,
          prompt: promptBlocks,
          parent,
          agentOptions: parent.options,
          signal: exec.signal,
        })
        // Atomic id minting: the record file is created exclusively, so a
        // concurrent delegate call can never silently overwrite this record.
        const delegation = await mintDelegationRecord(projectId, (id) => makeDelegationRecord(id, run.id))
        if (mode === 'sync') {
          try {
            const result = await run.result
            const output = renderBlocks(result.output)
            await updateRecordStatus(projectId, delegation.id, statusOf(result.stopReason), output)
            return {
              id: delegation.id,
              agent: args.agent,
              status: statusOf(result.stopReason),
              resultPath: delegation.resultPath,
              output,
            }
          } catch (error: unknown) {
            await persistSyncFailure(ctx, projectId, delegation.id, exec.signal, error)
            throw error
          } finally {
            try {
              await run.dispose()
            } catch (error: unknown) {
              ctx.logger.warn(
                `dh-delegation: could not dispose run for delegation "${delegation.id}": ${errorMessage(error)}`,
              )
            }
          }
        }
        runFinalizer(ctx, `finalizing one-shot delegation "${delegation.id}"`, async () => {
          let status = 'error'
          let output = ''
          try {
            const result = await run.result
            status = statusOf(result.stopReason)
            output = renderBlocks(result.output)
          } catch (error: unknown) {
            output = errorMessage(error)
          }
          try {
            await updateRecordStatus(projectId, delegation.id, status, output)
          } catch (error: unknown) {
            ctx.logger.warn(
              `dh-delegation: could not persist status "${status}" for delegation "${delegation.id}": ${errorMessage(error)}`,
            )
          }
          try {
            await run.dispose()
          } catch (error: unknown) {
            ctx.logger.warn(
              `dh-delegation: could not dispose run for delegation "${delegation.id}": ${errorMessage(error)}`,
            )
          }
        })
        return {
          id: delegation.id,
          agent: args.agent,
          status: 'running',
          resultPath: delegation.resultPath,
          output: '',
        }
      }

      // Continuable child (coder/scribe): `subagent/end` is the child's
      // terminal epoch edge (natural settlement or teardown), so the record is
      // finalized from it. The buffered watcher is attached BEFORE
      // `startContinuable` so a first-turn settlement racing the record write
      // is never lost.
      const endWatcher = watchSubagentEnds(ctx)
      let handedOff = false
      try {
        const started = await subagents.startContinuable({
          provider: args.agent,
          label,
          request: {
            prompt: promptBlocks,
            parent,
            agentOptions: parent.options,
          },
          signal: exec.signal,
        })
        const delegation = await mintDelegationRecord(
          projectId,
          (id) => makeDelegationRecord(id, started.childId),
        )
        if (mode === 'sync') {
          try {
            const info = await endWatcher.waitFor(started.childId, exec.signal)
            const output = renderBlocks(info.lastAssistantMessage ?? [])
            await updateRecordStatus(projectId, delegation.id, statusOf(info.stopReason), output)
            return {
              id: delegation.id,
              agent: args.agent,
              status: statusOf(info.stopReason),
              resultPath: delegation.resultPath,
              output,
            }
          } catch (error: unknown) {
            await persistSyncFailure(ctx, projectId, delegation.id, exec.signal, error)
            throw error
          }
        }
        handedOff = true
        runFinalizer(ctx, `finalizing continuable delegation "${delegation.id}"`, async () => {
          try {
            const info = await endWatcher.waitFor(started.childId)
            await updateRecordStatus(
              projectId,
              delegation.id,
              statusOf(info.stopReason),
              renderBlocks(info.lastAssistantMessage ?? []),
            )
          } catch (error: unknown) {
            ctx.logger.warn(
              `dh-delegation: could not finalize continuable delegation "${delegation.id}": ${errorMessage(error)}`,
            )
          } finally {
            endWatcher.dispose()
          }
        })
        return {
          id: delegation.id,
          agent: args.agent,
          status: 'running',
          resultPath: delegation.resultPath,
          output: '',
        }
      } finally {
        // The sync path is done waiting (or never started); the async path
        // handed the watcher to its background finalizer.
        if (!handedOff) endWatcher.dispose()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delegation_read',
    description: 'Read a persisted delegation record and its subagent output. Fails loud on an unknown id.',
    parameters: {
      id: { type: 'string', required: true, description: 'The readable delegation id (adjective-color-animal) returned by delegate' },
      projectId: { type: 'string', description: 'Project id (defaults to the basename of the session working directory)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          agent: { type: 'string', required: true },
          status: { type: 'string', required: true },
          startedAt: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
          resultPath: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          result: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `delegation ${value.id} (${value.agent}) ${value.status}\n\n${value.result || '(no result yet)'}`,
      }],
    },
    async execute(args, exec) {
      const projectId = parseProjectId(args.projectId ?? projectIdOf(exec))
      const read = await readRecord(projectId, args.id)
      let result = read.result
      if (read.record.status === 'running' && read.record.childId !== '') {
        const live = await liveOutputOf(ctx, read.record.childId)
        if (live.length > 0) result = live
      }
      return {
        id: read.record.id,
        agent: read.record.agent,
        status: read.record.status,
        startedAt: read.record.startedAt,
        updatedAt: read.record.updatedAt,
        resultPath: read.record.resultPath,
        prompt: read.record.prompt,
        result,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delegation_list',
    description: 'List persisted delegation records for the current project.',
    parameters: {
      projectId: { type: 'string', description: 'Project id (defaults to the basename of the session working directory)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          records: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', required: true },
                agent: { type: 'string', required: true },
                status: { type: 'string', required: true },
                startedAt: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.records.length === 0
          ? 'no delegations'
          : value.records.map(record => `${record.id} (${record.agent}) ${record.status}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const projectId = parseProjectId(args.projectId ?? projectIdOf(exec))
      const dir = delegationsDir(projectId)
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error: unknown) {
        if (isMissingDir(error)) return { records: [] }
        throw error
      }
      const records: Array<{ id: string; agent: string; status: string; startedAt: string; updatedAt: string }> = []
      for (const name of names) {
        if (!name.endsWith('.md')) continue
        const id = name.slice(0, -3)
        try {
          const read = await readRecord(projectId, id)
          records.push({
            id: read.record.id,
            agent: read.record.agent,
            status: read.record.status,
            startedAt: read.record.startedAt,
            updatedAt: read.record.updatedAt,
          })
        } catch (error: unknown) {
          // Surface unparseable records instead of silently dropping them.
          ctx.logger.warn(`dh-delegation: skipping unparseable delegation record "${id}": ${errorMessage(error)}`)
        }
      }
      records.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      return { records }
    },
  }))
}

/** Whether an fs error means the directory simply does not exist. */
function isMissingDir(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: string }).code === 'ENOENT'
}

/** Whether an fs error means an exclusive-create target already exists. */
function isFileExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST'
}
