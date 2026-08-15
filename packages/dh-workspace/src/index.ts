/**
 * dh-workspace — plan persistence and session-routing rules for the
 * dh-multiagents bundle.
 *
 * Registers `plan_save` / `plan_read` tools that persist markdown plans under
 * `$DSH_HOME/workspace/<projectId>/plan.md`, and injects per-preset routing
 * rules (plan/build/coder sessions) as dynamic system-prompt context.
 *
 * @module @dh-multiagents/dh-workspace
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'dh-workspace'
export const inject = ['tools', 'systemPrompt']

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Resolve `$DSH_HOME`, falling back to `~/.dsh` when unset. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** The project id: explicit param, else the basename of the session cwd. */
function projectIdOf(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  return basename(cwd)
}

/** Ensure the per-project workspace directory exists and return its path. */
async function ensureProjectDir(projectId: string): Promise<string> {
  const dir = join(dshHome(), 'workspace', projectId)
  await mkdir(dir, { recursive: true })
  return dir
}

/** The default plan path for one project. */
function planPathFor(projectId: string): string {
  return join(dshHome(), 'workspace', projectId, 'plan.md')
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

/** Whether the content opens with a top-level `# ` heading (an H1 line). */
function hasTopLevelHeading(content: string): boolean {
  return /^#(?:[^#]|$)/m.test(content)
}

// ---------------------------------------------------------------------------
// Routing rules (targeted by the session's agent preset)
// ---------------------------------------------------------------------------

const PLAN_RULES = [
  'You are in a plan session: produce a plan, never an implementation.',
  '',
  'Routing rules:',
  '- External research → delegate to the "researcher" subagent.',
  '- Codebase exploration → delegate to the "explore" subagent.',
  '- You are read-only: do not edit, write, or run code that changes anything.',
  '- Do not search yourself; route search work to the appropriate subagent.',
  '- Cite research findings as ref:<id>, using the delegation id returned by delegate.',
].join('\n')

const BUILD_RULES = [
  'You are in a build session: implement the approved plan.',
  '',
  'Routing rules:',
  '- Implementation → delegate to the "coder" subagent.',
  '- Documentation → delegate to the "scribe" subagent.',
  '- Review → delegate to the "reviewer" subagent.',
  '- You do not write code yourself; coordinate the builders.',
  '- Use worktree_create to isolate parallel work streams.',
].join('\n')

const PHILOSOPHY_LOAD_RULES = [
  'Before writing or modifying any code, you MUST:',
  '1. Load the code-philosophy skill (and frontend-philosophy for UI work).',
  '2. Verify your implementation against its checklist before completing.',
  '3. Refactor if any principle is violated.',
].join('\n')

/** The agent-preset roster surface this plugin reads (mirrors @deepseek-ai/dsh-agent-presets). */
interface AgentPresets {
  composedPreset(agentCtx: Context): string | undefined
}

interface RuleTarget {
  readonly name: string
  readonly preset: string
  readonly text: string
}

const RULE_TARGETS: readonly RuleTarget[] = [
  { name: 'dh:plan-rules', preset: 'plan', text: PLAN_RULES },
  { name: 'dh:build-rules', preset: 'build', text: BUILD_RULES },
  { name: 'dh:philosophy-load', preset: 'coder', text: PHILOSOPHY_LOAD_RULES },
]

/** The rules a session sees, decided by the preset it is composed from. */
function rulesForAgent(assemble: { agent?: { ctx: Context } | undefined }, target: RuleTarget): string {
  const agent = assemble.agent
  if (agent === undefined) return ''
  const presets = agent.ctx.get('agentPresets') as AgentPresets | undefined
  return presets?.composedPreset(agent.ctx) === target.preset ? target.text : ''
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'plan_save',
    description: 'Persist a markdown implementation plan under $DSH_HOME/workspace/<projectId>/plan.md. '
      + 'The content must begin with a top-level "# " heading.',
    parameters: {
      content: { type: 'string', required: true, description: 'Markdown plan text; must contain a top-level "# " heading' },
      projectId: { type: 'string', description: 'Project id (defaults to the basename of the session working directory)' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `plan saved to ${value.path} (${value.bytes} bytes)` }],
    },
    async execute(args, exec) {
      const content = args.content
      if (!hasTopLevelHeading(content)) {
        throw new Error('plan_save: content must contain a top-level "# " heading as its first non-empty line')
      }
      const projectId = args.projectId ?? projectIdOf(exec)
      const dir = await ensureProjectDir(projectId)
      const path = join(dir, 'plan.md')
      const bytes = Buffer.byteLength(content, 'utf8')
      await writeFile(path, content, 'utf8')
      return { path, bytes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plan_read',
    description: 'Read back the persisted markdown plan. Without a path, reads the current project\'s plan.md.',
    parameters: {
      path: { type: 'string', description: 'Absolute path to a plan file; defaults to $DSH_HOME/workspace/<projectId>/plan.md' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      const projectId = projectIdOf(exec)
      const path = args.path ?? planPathFor(projectId)
      if (!isAbsolute(path)) {
        throw new Error(`plan_read: path must be absolute, got "${path}"`)
      }
      let content: string
      try {
        content = await readFile(path, 'utf8')
      } catch (error: unknown) {
        throw new Error(`plan_read: no plan found at ${path} (${errorMessage(error)})`)
      }
      return { path, content }
    },
  }))

  for (const target of RULE_TARGETS) {
    ctx.systemPrompt.context({
      name: target.name,
      order: 125,
      text: (assemble) => rulesForAgent(assemble, target),
    })
  }
}

/** Extract a safe single-line message from an unknown error. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
