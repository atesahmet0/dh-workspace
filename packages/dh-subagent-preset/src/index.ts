/**
 * dh-subagent-preset — custom `SubagentProvider` bindings for the
 * dh-multiagents bundle.
 *
 * Registers five providers (`explore`, `researcher`, `coder`, `scribe`,
 * `reviewer`) whose children run the NAMED agent preset instead of inheriting
 * the parent's preset. The in-process child factory composes a child through
 * `agentPresets.composeFrom` (parent preset); a provider that wants a
 * different toolset must therefore create the child itself and re-link it via
 * `agentPresets.recompose(childCtx, '<preset>')` in the agent factory's
 * `setup` hook.
 *
 * The dsh subagent seam types (`@deepseek-ai/dsh-subagent`) are not declared
 * as dependencies of this bundle, so the provider contracts are mirrored here
 * as structural types. They match the published `0.1.0-rc.6` surface; keep the
 * two in sync when upgrading.
 *
 * @module @dh-multiagents/dh-subagent-preset
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRestriction, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { delegationDepthOf, errorMessage, finalAssistantOutput } from '@dh-multiagents/dh-common'

export const name = 'dh-subagent-preset'
export const inject = ['subagents']

// ---------------------------------------------------------------------------
// Structural types derived from the transitively-available dsh type surface
// ---------------------------------------------------------------------------

type AgentLike = NonNullable<ToolRunContext['agent']>
type SessionEventLike = AgentLike['session']['events'][number]
type SessionHeaderLike = AgentLike['session']['header']
type SessionIdBrand = SessionHeaderLike['id']
type UserMessageLike = Parameters<AgentLike['followup']>[0]
type ContentBlockLike = UserMessageLike['content'][number]
type AgentHandleLike = Awaited<ReturnType<Context['agents']['create']>>

/** The named presets this plugin binds children to (DESIGN.md §4, §6). */
type PresetId = 'explore' | 'researcher' | 'coder' | 'scribe' | 'reviewer'

// ---------------------------------------------------------------------------
// The subagent seam, structurally (mirrors @deepseek-ai/dsh-subagent)
// ---------------------------------------------------------------------------

interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

interface SubagentStartRequest {
  readonly label?: string
  readonly prompt: readonly ContentBlockLike[]
  readonly parent: AgentLike
  readonly signal: AbortSignal
  readonly agentOptions?: AgentLike['options']
  readonly outputSchema?: unknown
  readonly maxDepth?: number
  readonly toolFilter?: ToolRestriction
  readonly persona?: string
}

interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  readonly descriptor: unknown
}

interface SubagentResult {
  readonly output: readonly ContentBlockLike[]
  readonly structured?: unknown
  readonly stopReason: string
}

interface SubagentRun {
  readonly id: SessionIdBrand
  readonly localAgent: AgentLike | undefined
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

interface ContinuableCreateRequest {
  readonly sessionId: SessionIdBrand
  readonly parent: AgentLike
  readonly signal: AbortSignal
}

interface ContinuableCreateSpec {
  readonly seed?: readonly SessionEventLike[]
}

interface SubagentProvider {
  readonly name: string
  readonly capabilities: SubagentCapabilities
  readonly inheritsParentContext: boolean
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}

interface SubagentRuntime {
  registerProvider(provider: SubagentProvider): () => void
  start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
  startContinuable(spec: {
    readonly provider: string
    readonly label: string
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
    readonly signal: AbortSignal
  }): Promise<{ readonly childId: SessionIdBrand; readonly messageId: unknown }>
  getProvider(name: string): SubagentProvider | undefined
  list(): string[]
  registerContinuableSetup(contribution: (childCtx: Context) => () => void): () => void
}

/** The agent-preset roster surface this plugin uses (mirrors @deepseek-ai/dsh-agent-presets). */
interface AgentPresets {
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined
  composedPreset(agentCtx: Context): string | undefined
  recompose(agentCtx: Context, id: string): Promise<unknown>
  standingKeyFor(id?: string): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Provider roster
// ---------------------------------------------------------------------------

interface ProviderSpec {
  readonly name: PresetId
  readonly presetId: PresetId
  readonly oneShot: boolean
  readonly inheritsParentContext: boolean
}

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  { name: 'explore', presetId: 'explore', oneShot: true, inheritsParentContext: false },
  { name: 'researcher', presetId: 'researcher', oneShot: true, inheritsParentContext: false },
  { name: 'reviewer', presetId: 'reviewer', oneShot: true, inheritsParentContext: false },
  { name: 'coder', presetId: 'coder', oneShot: false, inheritsParentContext: true },
  { name: 'scribe', presetId: 'scribe', oneShot: false, inheritsParentContext: true },
]

/** Provider name → the preset its children must run on. */
const PRESET_BY_PROVIDER: Readonly<Record<PresetId, PresetId>> = {
  explore: 'explore',
  researcher: 'researcher',
  reviewer: 'reviewer',
  coder: 'coder',
  scribe: 'scribe',
}

/**
 * Model-facing delegation-scope statement for every in-process child, identical
 * to the harness's own `SUBAGENT_DELEGATION_CONTEXT`.
 */
const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'

// ---------------------------------------------------------------------------
// Child composition helpers
// ---------------------------------------------------------------------------

/** The balanced completed-turn prefix of the parent's log, used as a fork seed. */
function completedTurnPrefix(parent: AgentLike): readonly SessionEventLike[] {
  const events = parent.session.events
  const lastEnd = events.findLast(event => event.type === 'turn/end')
  if (lastEnd === undefined) return []
  return events.slice(0, lastEnd.seq + 1)
}

/** Re-link an unpublished child onto the named preset's standing composition. */
async function composeNamedPreset(childCtx: Context, presetId: PresetId): Promise<void> {
  const presets = childCtx.get('agentPresets') as AgentPresets | undefined
  if (presets === undefined) {
    throw new Error(
      `dh-subagent-preset: cannot compose child onto preset "${presetId}" because the agent-presets service is not composed`,
    )
  }
  await presets.recompose(childCtx, presetId)
}

/** Build the durable session metadata for a child running a named preset. */
function childSessionMeta(parent: AgentLike, presetId: PresetId, childDepth: number) {
  const header = parent.session.header
  return {
    ...header.cwd !== undefined ? { cwd: header.cwd } : {},
    parentSession: header.id,
    origin: 'subagent' as const,
    delegationDepth: childDepth,
    agentPreset: presetId,
  }
}

/** Build a fresh user-role message (the `createUserMessage` contract). */
function createUserMessageLike(content: readonly ContentBlockLike[]): UserMessageLike {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'user' },
  } as unknown as UserMessageLike
}

/** Map a turn end reason to the subagent seam's terminal vocabulary. */
function toStopReason(reason: { readonly kind: string } | undefined): string {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** Read one settled child's result. */
function readChildResult(child: AgentLike, cancelled: boolean): SubagentResult {
  const events = child.session.events
  const lastEnd = events.findLast(event => event.type === 'turn/end')
  // The shared selector returns a structural block type; the provider seam
  // expects the precise content-block union, so narrow at this boundary.
  const output = (finalAssistantOutput(events) ?? []) as readonly ContentBlockLike[]
  const recorded = toStopReason(lastEnd?.data.reason)
  const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  return { output, stopReason }
}

/**
 * Wrap a published child in the one-shot run lifecycle: signal handoff, one
 * turn, result settlement, and quiescent disposal.
 */
function drivePublishedRun(
  handle: AgentHandleLike,
  signal: AbortSignal,
  prompt: readonly ContentBlockLike[],
  childId: SessionIdBrand,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // Agent creation detaches its creation-only listener before returning.
  if (signal.aborted) onAbort()

  const result: Promise<SubagentResult> = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessageLike(prompt))
        await child.whenIdle()
      }
      return readChildResult(child, flags.cancelled)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const settlements = await Promise.allSettled([handle.dispose(), result])
      const disposal = settlements[0]
      // The result channel owns run faults; disposal reports only failure to
      // release the published handle after both operations settle.
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

// ---------------------------------------------------------------------------
// The provider implementation
// ---------------------------------------------------------------------------

class PresetSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    // outputSchema is not implemented for these children, so it must not be
    // advertised (the harness rejects requested capabilities the provider lacks).
    outputSchema: false,
    depthLimit: true,
    toolFilter: true,
    persona: true,
  }

  constructor(
    readonly name: string,
    private readonly presetId: PresetId,
    private readonly oneShot: boolean,
    readonly inheritsParentContext: boolean,
  ) {}

  /** Establish a ONE-SHOT child that runs this provider's named preset. */
  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const parent = request.parent
    const childDepth = delegationDepthOf(parent) + 1
    if (request.maxDepth !== undefined && childDepth > request.maxDepth) {
      throw new Error(
        `dh-subagent-preset: subagent depth ${childDepth} exceeds maxDepth ${request.maxDepth}`,
      )
    }
    if (request.signal.aborted) {
      throw new Error('dh-subagent-preset: subagent request was aborted before child publication')
    }

    const childId = randomUUID() as unknown as SessionIdBrand
    const handle = await parent.ctx.agents.create({
      sessionId: childId,
      meta: childSessionMeta(parent, this.presetId, childDepth),
      ...request.agentOptions !== undefined ? { agentOptions: request.agentOptions } : {},
      signal: request.signal,
      setup: async (childCtx: Context): Promise<void> => {
        await composeNamedPreset(childCtx, this.presetId)
        childCtx.systemPrompt.context({
          name: 'subagent:delegation',
          order: 120,
          text: SUBAGENT_DELEGATION_CONTEXT,
        })
        if (request.persona !== undefined) {
          childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: request.persona })
        }
        if (request.toolFilter !== undefined) childCtx.tools.restrict(request.toolFilter)
      },
    })
    return drivePublishedRun(handle, request.signal, request.prompt, childId)
  }

  /** Contribute the detached creation spec for a continuable child. */
  async prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    if (this.oneShot) {
      throw new Error(`dh-subagent-preset: provider "${this.name}" does not support continuable children`)
    }
    // A continuable coder/scribe child is seeded with the parent's completed
    // turns, exactly like the harness fork provider.
    const seed = completedTurnPrefix(request.parent)
    return seed.length > 0 ? { seed } : {}
  }
}

// ---------------------------------------------------------------------------
// Continuable-children preset binding
// ---------------------------------------------------------------------------

/**
 * The continuation manager composes continuable children itself (via
 * `applyChildComposition` → `composeFrom`), so a provider's `prepareContinuable`
 * cannot re-link the child. This contribution runs inside the child's setup
 * window and re-links it onto the preset named by its persisted descriptor.
 *
 * Fail-loud: when the binding cannot be established (no agent-presets service,
 * or no descriptor mapping to a named preset), the contribution throws inside
 * the unpublished creation window, which aborts the child creation instead of
 * leaving it under the parent's (possibly read-only) preset. The seam's setup
 * contribution is synchronous, so the async rebind itself cannot be awaited
 * here; a rejected rebind cancels the child and surfaces the failure loudly
 * instead of silently running under the parent's composition.
 */
function applyNamedPresetToContinuableChild(childCtx: Context): () => void {
  const descriptor = childCtx.agent?.session.events.findLast(
    event => (event as { type: string }).type === 'subagent/descriptor',
  )
  const provider = descriptor !== undefined
    ? (descriptor as unknown as { data?: { provider?: PresetId } }).data?.provider
    : undefined
  const presetId = provider !== undefined ? PRESET_BY_PROVIDER[provider] : undefined
  if (presetId === undefined) {
    throw new Error(
      `dh-subagent-preset: continuable child has no descriptor mapping to a named preset `
      + `(provider: ${String(provider)}); aborting child creation instead of running it under the parent's preset`,
    )
  }
  const presets = childCtx.get('agentPresets') as AgentPresets | undefined
  if (presets === undefined) {
    throw new Error(
      `dh-subagent-preset: cannot bind continuable child onto preset "${presetId}" because the `
      + "agent-presets service is not composed; aborting child creation instead of running it under the parent's preset",
    )
  }
  // Re-link inside the creation window, mirroring the one-shot path's async
  // setup. On rejection the child is cancelled (never silently left under the
  // parent's composition) and the failure is surfaced loudly.
  void presets.recompose(childCtx, presetId).catch((error: unknown) => {
    childCtx.logger.error(
      `dh-subagent-preset: failed to re-link continuable child onto preset "${presetId}"; `
      + `cancelling the child instead of running it under the parent's preset: ${errorMessage(error)}`,
    )
    childCtx.agent?.cancel({ kind: 'parent' })
  })
  return () => {}
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {
  const subagents = ctx.get('subagents') as unknown as SubagentRuntime
  for (const spec of PROVIDER_SPECS) {
    subagents.registerProvider(
      new PresetSubagentProvider(spec.name, spec.presetId, spec.oneShot, spec.inheritsParentContext),
    )
  }
  subagents.registerContinuableSetup(applyNamedPresetToContinuableChild)

  // Pre-warm each named preset's standing mount so a continuable child's
  // re-link (started in the setup contribution above) has nothing to mount at
  // delegation time.
  ctx.inject(['agentPresets'], (presetCtx: Context) => {
    for (const id of Object.keys(PRESET_BY_PROVIDER) as PresetId[]) {
      void (presetCtx.get('agentPresets') as unknown as AgentPresets).standingKeyFor(id).catch(
        (error: unknown) => {
          presetCtx.logger.warn(`dh-subagent-preset: preset "${id}" could not be pre-warmed: ${String(error)}`)
        },
      )
    }
  })
}
