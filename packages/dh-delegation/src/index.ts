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

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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

/** Write the record markdown (frontmatter + prompt/result bodies) and the result file. */
async function writeRecord(projectId: string, record: DelegationRecord, result: string): Promise<void> {
  const dir = delegationsDir(projectId)
  await mkdir(dir, { recursive: true })
  const markdown = [
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
  await writeFile(join(dir, `${record.id}.md`), markdown, 'utf8')
  await writeFile(record.resultPath, result, 'utf8')
}

/** Whether a delegation id is already taken in the project directory. */
async function recordExists(projectId: string, id: string): Promise<boolean> {
  try {
    await readFile(join(delegationsDir(projectId), `${id}.md`), 'utf8')
    return true
  } catch (error: unknown) {
    if (isMissingDir(error)) return false
    throw error
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

/** Resolve once `subagent/end` fires for exactly one child. */
function awaitSubagentEnd(ctx: Context, childId: string, signal: AbortSignal): Promise<SubagentEndInfo> {
  return new Promise<SubagentEndInfo>((resolve, reject) => {
    let dispose: () => void = () => {}
    const onAbort = (): void => {
      dispose()
      reject(new Error(`delegate: waiting for subagent "${childId}" was aborted`))
    }
    dispose = ctx.on('subagent/end', (info) => {
      if (info.id !== childId) return
      dispose()
      signal.removeEventListener('abort', onAbort)
      resolve(info)
    })
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
      // Mint a collision-free id rather than silently overwriting a record.
      let id = readableDelegationId()
      while (await recordExists(projectId, id)) {
        id = readableDelegationId()
      }
      const label = args.prompt.length > 80 ? `${args.prompt.slice(0, 80)}…` : args.prompt
      const startedAt = new Date().toISOString()
      const mode = args.mode ?? 'async'
      const resultPath = resultFileFor(projectId, id)
      const promptBlocks: readonly ContentBlockLike[] = [{ type: 'text', text: args.prompt }]

      let run: SubagentRun | undefined
      let childId: SessionIdBrand
      if (isOneShot(args.agent)) {
        run = await subagents.start(args.agent, {
          label,
          prompt: promptBlocks,
          parent,
          agentOptions: parent.options,
          signal: exec.signal,
        })
        childId = run.id
      } else {
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
        childId = started.childId
      }
      const record: DelegationRecord = {
        id,
        agent: args.agent,
        prompt: args.prompt,
        status: 'running',
        startedAt,
        updatedAt: startedAt,
        resultPath,
        childId,
      }
      await writeRecord(projectId, record, '')

      if (run !== undefined) {
        if (mode === 'sync') {
          const result = await run.result
          const output = renderBlocks(result.output)
          await updateRecordStatus(projectId, id, statusOf(result.stopReason), output)
          await run.dispose()
          return { id, agent: args.agent, status: statusOf(result.stopReason), resultPath, output }
        }
        void run.result.then(async (result) => {
          await updateRecordStatus(projectId, id, statusOf(result.stopReason), renderBlocks(result.output))
        }).catch(async (error: unknown) => {
          await updateRecordStatus(projectId, id, 'error', errorMessage(error))
        }).finally(async () => {
          await run.dispose()
        })
        return { id, agent: args.agent, status: 'running', resultPath, output: '' }
      }

      // Continuable child (coder/scribe): `subagent/end` is an epoch/turn
      // signal, NOT settlement — the child may be continued. Keep the record
      // running and let delegation_read's live-output branch be the truth.
      if (mode === 'sync') {
        const info = await awaitSubagentEnd(ctx, childId, exec.signal)
        const output = renderBlocks(info.lastAssistantMessage ?? [])
        return { id, agent: args.agent, status: 'running', resultPath, output }
      }
      return { id, agent: args.agent, status: 'running', resultPath, output: '' }
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
