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

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { confinePath, errorMessage, parseProjectId, projectDir, projectIdOf } from '@dh-multiagents/dh-common'

export const name = 'dh-workspace'
export const inject = ['tools', 'systemPrompt']

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Ensure the per-project workspace directory exists and return its path. */
async function ensureProjectDir(projectId: string): Promise<string> {
  const dir = projectDir(projectId)
  await mkdir(dir, { recursive: true })
  return dir
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
// Preset mirroring (boot-time replacement for the former postinstall script)
// ---------------------------------------------------------------------------

/**
 * Candidate locations of the bundle's agent-presets directory, resolved from
 * THIS plugin's compiled file (never cwd). The first that exists wins.
 *
 * - Installed (hoisted, the dsh profile default): from
 *   `node_modules/@dh-multiagents/dh-workspace/lib/index.js`,
 *   `../../../@dh-multiagents/bundle/presets/` lands on the bundle's presets.
 * - Source tree (dev): from `packages/dh-workspace/lib/index.js`,
 *   `../../../presets/` lands on the repo-root `presets/`.
 */
const BUNDLE_PRESETS_CANDIDATES = [
  '../../../@dh-multiagents/bundle/presets/',
  '../../../presets/',
] as const

/** The first candidate presets directory that exists on disk, else undefined. */
function resolveBundlePresets(): string | undefined {
  for (const candidate of BUNDLE_PRESETS_CANDIDATES) {
    const path = fileURLToPath(new URL(candidate, import.meta.url))
    if (existsSync(path)) return path
  }
  return undefined
}

/**
 * Mirror the bundle's agent-presets into the user root
 * (`$DSH_HOME/.agent-presets`, enabled via `includeUserRoot: true`) so the dsh
 * CLI's own shipped root (which replaces `roots`, DESIGN.md §4) does not hide
 * them. Runs synchronously at boot, before any preset composition reads the
 * user root. Idempotent (recursive copy, overwrite ok, dotfiles skipped) and
 * fail-soft: the plugin always boots even when there is nothing to mirror.
 */
function mirrorPresetsAtBoot(ctx: Context): void {
  try {
    const dshHomePath = ctx.get('dshHomePath') as ((p?: string) => string | undefined) | undefined
    const home = dshHomePath?.() ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const sourceDir = resolveBundlePresets()
    if (sourceDir === undefined) {
      ctx.logger.warn('dh-workspace: bundle presets directory not found; skipping preset mirror')
      return
    }
    const targetDir = join(home, '.agent-presets')
    mkdirSync(targetDir, { recursive: true })
    for (const entry of readdirSync(sourceDir)) {
      if (entry.startsWith('.')) continue
      cpSync(join(sourceDir, entry), join(targetDir, entry), { recursive: true })
    }
  } catch (error: unknown) {
    ctx.logger.warn(`dh-workspace: preset mirror failed (${errorMessage(error)}); continuing without mirrored presets`)
  }
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {
  mirrorPresetsAtBoot(ctx)

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
      const projectId = parseProjectId(args.projectId ?? projectIdOf(exec))
      const dir = await ensureProjectDir(projectId)
      const path = join(dir, 'plan.md')
      const bytes = Buffer.byteLength(content, 'utf8')
      await writeFile(path, content, 'utf8')
      return { path, bytes }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'plan_read',
    description: 'Read back the persisted markdown plan. The path is resolved against '
      + '$DSH_HOME/workspace/<projectId>/ and must stay inside that directory.',
    parameters: {
      path: { type: 'string', description: 'Path within the project workspace (relative, or absolute inside it); defaults to plan.md' },
      projectId: { type: 'string', description: 'Project id (defaults to the basename of the session working directory)' },
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
      const projectId = parseProjectId(args.projectId ?? projectIdOf(exec))
      const path = confinePath(projectDir(projectId), args.path ?? 'plan.md')
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
