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
- **pnpm 11 build-script gate**: pnpm 11 blocks dependency postinstall
  scripts by default — approve the bundle's preset-mirror script via
  `allowBuilds` in the profile's `pnpm-workspace.yaml` (see
  [Deploying](#deploying-into-a-dsh-profile)).

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

The bundle is published to npm (`@dh-multiagents/bundle` + 6 sub-packages), so
a deployed profile is just the registry package plus the built-in postinstall.

### Quick start (registry install)

```bash
# 1. Create the profile (dsh CLI creates it under $DSH_HOME/profiles/<name>)
dsh plugin --profile <name> init

# 2. Add the bundle — installs @dh-multiagents/bundle and its deps, then the
#    postinstall mirrors presets/ into $DSH_HOME/.agent-presets/ automatically
dsh plugin --profile <name> add @dh-multiagents/bundle

# 3. Boot
DEEPSEEK_API_KEY=... dsh --profile <name> headless "your task"
```

**pnpm 11 build-script gate (required once):** pnpm 11 blocks dependency
postinstall scripts by default. Approve the bundle's mirror script by adding
this to the profile's `pnpm-workspace.yaml` (note the **quoted key**):

```yaml
allowBuilds:
  "@dh-multiagents/bundle": true
```

then re-run `pnpm install` (or `pnpm rebuild @dh-multiagents/bundle`) once so
the mirror runs. Without this, packages install fine but presets are not
auto-mirrored — see the manual fallback below.

### What the install does (and why nothing else is needed)

1. **Plugins** — the bundle's `cordis.patch.yml` inserts the four plugin rows
   (`dh-workspace`, `dh-delegation`, `dh-subagent-preset`, `dh-worktree`) on
   top of `dsh-base`.
2. **Skills** — nothing to do: the bundle wires the `skill-filesystem` row
   itself (its `cordis.patch.yml` overrides `bundledSkillDir` to point at the
   installed `dh-philosophy` package), so no profile patch is needed.
3. **Presets** — required because the dsh CLI appends its own shipped preset
   root as the *last* overlay, which replaces the bundle's `roots` (see
   `DESIGN.md` §4). The bundle's `postinstall` script mirrors `presets/` into
   `$DSH_HOME/.agent-presets/` automatically on install (the `agent-presets`
   row keeps `includeUserRoot: true` so they are discovered alongside the
   CLI's own).

   Manual fallback (if you install with scripts skipped):

   ```bash
   mkdir -p "$DSH_HOME/.agent-presets"
   node node_modules/@dh-multiagents/bundle/scripts/mirror-presets.mjs
   ```

### Boot & verify

```bash
dsh --profile <your-profile> --dump-config   # verify the composition
DEEPSEEK_API_KEY=... dsh --profile <your-profile> headless "your task"
```

### Installing from source (development)

The `@dh-multiagents/*` packages are workspace-linked during development.
Build and pack them, then point the profile at the tarballs:

```bash
pnpm install && pnpm -r build
for p in dh-common dh-delegation dh-philosophy dh-subagent-preset dh-workspace dh-worktree; do
  (cd packages/$p && pnpm pack --pack-destination /tmp/tarballs)
done
pnpm pack --pack-destination /tmp/tarballs   # root = @dh-multiagents/bundle
```

> ⚠️ **Publish note:** always publish via `pnpm pack` tarballs, never
> `npm publish` from the source dir — npm does not rewrite the `workspace:*`
> protocol, which breaks installs (0.1.0 shipped broken this way).

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
