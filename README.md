# dh-multiagents

A multi-agent orchestration bundle for the **DeepSeek Harness (dsh)**. It turns
a dsh profile into a team of specialized agents — a read-only **plan**
orchestrator that delegates research and exploration, a **build** orchestrator
that isolates implementation in git worktrees, and role-bound subagents
(researcher, explore, coder, scribe, reviewer) whose tools are enforced by a
runtime capability matrix.

The bundle ships four cordis plugins plus a skills package:

| Package | Kind | What it provides |
|---|---|---|
| `@dh-multiagents/dh-workspace` | cordis plugin | `plan_save` / `plan_read` tools + per-preset routing rules injected into the system prompt |
| `@dh-multiagents/dh-delegation` | cordis plugin | `delegate` / `delegation_read` / `delegation_list` tools with persisted, reviewable delegation records |
| `@dh-multiagents/dh-subagent-preset` | cordis plugin | custom `SubagentProvider`s (explore, researcher, coder, scribe, reviewer) that bind each child to its named preset |
| `@dh-multiagents/dh-worktree` | cordis plugin | `worktree_create` / `worktree_delete` tools for parallel work isolation |
| `@dh-multiagents/dh-philosophy` | skills package (NOT a plugin) | five `SKILL.md` files: `code-philosophy`, `frontend-philosophy`, `code-review`, `plan-review`, `plan-protocol` |

> **Naming contract:** `DESIGN.md` is the authoritative identifier lock — every
> package name, tool name, preset id, skill name, and dependency range pinned
> there must be reused verbatim. If an identifier must change, change it in
> `DESIGN.md` first.

---

## Agent presets & the capability matrix

Seven presets live under `presets/<name>/`, each composed of an
`agent.cordis.yml` (persona + composition) and a `preset.yml` (metadata).

| Preset | Role | Tools granted (allow-list) |
|---|---|---|
| `plan` | Read-only orchestrator: delegates research/exploration, writes the plan | `plan_save`, `plan_read`, `delegate`, `delegation_read`, `delegation_list`, `subagent`, `subagent_fork`, `send_message`, `interrupt_agent`, `list_agents`, `skill`, `todo_write`, goal tools |
| `build` | Read-only orchestrator: delegates builders, isolates work with worktrees | `delegate`, `delegation_*`, `subagent*`, `send_message`, `interrupt_agent`, `list_agents`, `worktree_create`, `worktree_delete`, `skill`, `todo_write` |
| `explore` | Read-only codebase explorer | `read`, `glob`, `grep`, `read_image` |
| `researcher` | Read-only external researcher | `web_search`, `read`, `glob`, `grep` |
| `coder` | Write-capable implementer | `bash`, `edit`, `write`, `read`, `glob`, `grep`, `read_image`, `str_replace_editor`, `worktree_*`, `skill`, `todo_write` |
| `scribe` | Documentation writer | `edit`, `write`, `read` |
| `reviewer` | Read-only reviewer | `read`, `glob`, `grep` |

**Enforcement:** the matrix is defined once in code —
`CAPABILITY_MATRIX` + `restrictPresetTools()` in `packages/dh-common/src/index.ts`
— and applied at runtime via `ctx.tools.restrict({ allow })` in the
dh-subagent-preset provider. A preset-composed agent literally never sees tools
outside its allow-list, even transiently.

**Delegation privilege boundary:** only `plan` and `build` may call `delegate`.
`plan` may delegate to `explore`/`researcher`; `build` additionally to
`coder`/`scribe`/`reviewer`. Delegation from inside a subagent is rejected
(anti-recursion). This is enforced in `dh-delegation` at the privilege boundary,
not merely documented.

---

## Prerequisites

- **Node.js** `^22.19.0 || >=24.0.0` (repo pins `engines`)
- **pnpm** `11.7.0` (`packageManager` field; corepack or `npm i -g pnpm@11.7.0`)
- A **DeepSeek Harness** install (`@deepseek-ai/dsh` on npm, `0.1.0-rc.6` line)
- A **DeepSeek API key** (`DEEPSEEK_API_KEY` env var for the `llm-deepseek` row)

Dependency line (pinned — see `DESIGN.md` §8): `@deepseek-ai/cordis ^4.0.1`,
`@deepseek-ai/dsh-tools ^0.1.0-rc.6`, `@deepseek-ai/schemastery ^3.18.1`.
`.npmrc` sets `save-exact=true` so future installs stay on the `0.1.0-rc.6`
(`next`) release line — a bare `latest` for most `@deepseek-ai/dsh-*` packages
resolves the **stale** `0.0.1-rc.1` line.

---

## Install & build

```bash
pnpm install        # installs all workspace packages
pnpm -r build       # compiles each package src/ -> lib/ (tsc)
```

Per-package scripts: `pnpm -r typecheck`, `pnpm clean` (removes `lib/`).

---

## Deploying into a dsh profile

1. **Create a profile** that mounts the bundle (see `profile/package.json` in
   this repo for the manifest shape):

   ```json
   {
     "dependencies": {
       "@deepseek-ai/dsh-base": "0.1.0-rc.6",
       "@dh-multiagents/bundle": "<path or registry ref>"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@dh-multiagents/bundle"]
       }
     }
   }
   ```

   > The `@dh-multiagents/*` packages are workspace-linked during development;
   > for a deployed profile, pack them (`pnpm pack`) and install the tarballs.

2. **Surface the philosophy skills** — the profile's `cordis.patch.yml`
   overrides the `skill-filesystem` row so the five `SKILL.md` packages are
   discovered:

   ```yaml
   - id: skill-filesystem
     name: '@deepseek-ai/dsh-skill-filesystem'
     config:
       bundledSkillDir: !!js 'new URL("node_modules/@dh-multiagents/dh-philosophy/skills", baseUrl).pathname'
   ```

3. **Mirror the presets into the user preset root** (required — the dsh CLI
   appends its own shipped preset root as the *last* overlay, which replaces
   the bundle's `roots`; see `DESIGN.md` §4):

   ```bash
   mkdir -p "$DSH_HOME/.agent-presets"   # DSH_HOME defaults to ~/.dsh
   cp -r presets/* "$DSH_HOME/.agent-presets/"
   ```

   The `agent-presets` row must keep `includeUserRoot: true` (the bundle patch
   sets it) so the mirrored presets are discovered alongside the CLI's own.

4. **Boot**:

   ```bash
   dsh --profile <your-profile> --dump-config   # verify the composition
   DEEPSEEK_API_KEY=... dsh --profile <your-profile> headless "your task"
   ```

---

## Runtime behavior

- `plan_save` persists `plan.md` under
  `$DSH_HOME/workspace/<projectId>/` and requires a top-level `# ` heading;
  `plan_read` resolves paths inside that directory and is traversal-safe
  (`confinePath` uses realpath, not lexical checks).
- `delegate` mints a readable id (`adjective-color-animal`), persists a record
  as `delegations/<id>.md`, and writes the child's final output to
  `<id>.result.txt` — auditable after the fact.
- One-shot providers (explore/researcher/reviewer) run to completion;
  coder/scribe are continuable.
- Children inherit the parent's model selection (`agentOptions`) — fixed in
  PR #1; before that, one-shot children were created without a model and died
  at startup (`[diagnostic: corrupt]`).

---

## Development

```bash
pnpm -r build       # compile
pnpm -r typecheck   # typecheck
```

Adding a preset: create `presets/<name>/agent.cordis.yml` + `preset.yml`, add
the allow-list to `CAPABILITY_MATRIX` in `dh-common`, and (if it may delegate)
extend `DELEGATION_ROLES_BY_CALLER_PRESET` in `dh-delegation`.

Adding a skill: add `skills/<name>/SKILL.md` under `dh-philosophy` with the
frontmatter keys documented in `DESIGN.md` §7 (`name`, `description`,
`disable-model-invocation`, `user-invocable`, optional `whenToUse`/`metadata`).

**Tests:** a live integration test (boot a harness profile, exercise
`plan_save` → `delegate` → `delegation_read`) is planned; until it lands, the
manual verification procedure is documented in the PR that fixed one-shot
delegation (PR #1).

---

## Repository layout

```
cordis.patch.yml              # bundle patch: base layering + plugin rows
DESIGN.md                     # naming-lock contract (read this first)
packages/
  dh-common/                  # CAPABILITY_MATRIX, path confinement, shared helpers
  dh-delegation/              # delegate / delegation_read / delegation_list
  dh-philosophy/              # 5 SKILL.md files (not a plugin)
  dh-subagent-preset/         # SubagentProviders bound to named presets
  dh-worktree/                # worktree_create / worktree_delete
  dh-workspace/               # plan_save / plan_read + routing rules
presets/                      # 7 agent presets (agent.cordis.yml + preset.yml)
profile/                      # deployable profile manifest + patch + settings
pnpm-workspace.yaml
tsconfig.base.json
```
