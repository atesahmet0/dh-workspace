# dh-multiagents — Design Contract (Naming Lock)

> Phase 2 scaffold artifact. This file locks the identifiers that every later
> phase MUST reuse verbatim. If an identifier must change, change it HERE first
> and update all phases; never fix a name in code without updating this file.
>
> Ground truth: the dsh API reference (Phase 1) and the reference clone
> `~/Documents/projects/dsh-reference` (commit 47f9438).

---

## 1. Package scope and names

npm scope: **`@dh-multiagents/`** (changeable — the dsh-root repo ships a
`scripts/change-scope.ts`; this monorepo can do the same if the scope ever
needs to change).

| Directory | Package | Kind |
|---|---|---|
| `./` (workspace root) | `@dh-multiagents/bundle` | out-of-tree bundle package; root `package.json` carries `dsh.bundle.patch: ./cordis.patch.yml` |
| `packages/dh-philosophy` | `@dh-multiagents/dh-philosophy` | skills package — markdown `SKILL.md` files, **NOT** a plugin, no cordis row |
| `packages/dh-workspace` | `@dh-multiagents/dh-workspace` | cordis plugin (plan persistence + routing) |
| `packages/dh-delegation` | `@dh-multiagents/dh-delegation` | cordis plugin (async delegation tools) |
| `packages/dh-subagent-preset` | `@dh-multiagents/dh-subagent-preset` | cordis plugin (custom `SubagentProvider`) |
| `packages/dh-worktree` | `@dh-multiagents/dh-worktree` | cordis plugin (worktree create/delete) |

Plugin packages are ESM-only (`"type": "module"`), compile `src/` → `lib/` with
`tsc`, and are publishable (no `private: true`). The root bundle and the
profile manifest are `private: true`.

## 2. Plugin row ids (cordis.patch.yml)

| Row `id` | Module (`name`) |
|---|---|
| `dh-workspace` | `@dh-multiagents/dh-workspace` |
| `dh-delegation` | `@dh-multiagents/dh-delegation` |
| `dh-subagent-preset` | `@dh-multiagents/dh-subagent-preset` |
| `dh-worktree` | `@dh-multiagents/dh-worktree` |

`@dh-multiagents/dh-philosophy` has **no** row (not a plugin).

## 3. Tool names (registered via `ctx.tools.register(defineTool({ ... }))`)

| Plugin | Tool names |
|---|---|
| `dh-workspace` | `plan_save`, `plan_read` |
| `dh-delegation` | `delegate`, `delegation_read`, `delegation_list` |
| `dh-subagent-preset` | none — registers subagent providers (§6), not tools |
| `dh-worktree` | `worktree_create`, `worktree_delete` |

Reserved: the name `run_code` cannot be registered.

## 4. Agent presets

Preset names (7): **`plan`, `build`, `explore`, `researcher`, `coder`, `scribe`,
`reviewer`**.

Each preset is a **directory** named after the preset, containing exactly:
- `agent.cordis.yml` — the agent-plane composition (list of plugin rows /
  `cordis:group`s, one standing mount per preset).
- `preset.yml` — metadata: `name`, `description`, `order`.

Rules that apply to every preset composition (from the dsh API reference):
- A row that publishes a process-global service MUST sit inside a
  `cordis:group` with `group: true` and an `isolate` realm, else
  `dsh-agent-presets` rejects the mount at the leaked-services check.
- `toolFilter` restricts global tool names only; scope-local (preset-registered)
  names are not restrictable.
- An in-process subagent child inherits its parent's preset via
  `agentPresets.composeFrom`; the only built-in per-child knobs are `persona`
  text, `toolFilter`, and `agentOptions`.

## 5. Skills

Skill names (5): **`code-philosophy`, `frontend-philosophy`, `code-review`,
`plan-review`, `plan-protocol`**.

Shipped by `@dh-multiagents/dh-philosophy` as `skills/<name>/SKILL.md`
(one directory per skill). Surfaced via the `skill-filesystem` provider
(`customSkillDirs` / `bundledSkillDir`) in Phase 9.

## 6. Subagent providers

Custom `SubagentProvider` names registered by `dh-subagent-preset`:
**`explore`, `researcher`, `coder`, `scribe`, `reviewer`**.

Each provider binds a child to the named preset (§4) by composing the child via
`agentPresets.recompose(childCtx, '<preset-name>')` / `mount()` instead of the
default `composeFrom` — the only way an in-process child can run a different
toolset than its parent. Provider `capabilities` and `inheritsParentContext`
must be decided per provider in Phase 9.

## 7. SKILL.md frontmatter keys

The dsh `skill-filesystem` provider accepts exactly these frontmatter keys in
every `SKILL.md`:

| Key | Required | Notes |
|---|---|---|
| `name` | ✅ | kebab-case, `^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `description` | ✅ | short routing description |
| `whenToUse` | — | optional guidance |
| `disable-model-invocation` | — | boolean; legacy `modelInvocable` / `disableModelInvocation` are rejected |
| `user-invocable` | — | boolean, default `true` |
| `metadata` | — | optional object, passthrough |

All five philosophy skills use `disable-model-invocation: false` and
`user-invocable: true` so both model and user can invoke them.

```markdown
---
name: code-philosophy
description: The 5 Laws of Elegant Defense — internal logic and data flow standards
whenToUse: Any implementation or refactor of backend, logic, or data-flow code
disable-model-invocation: false
user-invocable: true
metadata:
  phase: 2
---

Markdown instruction body ...
```

## 8. Dependency line (MUST match the deployed harness)

| Package | Range (peer + dev) | Why |
|---|---|---|
| `@deepseek-ai/cordis` | `^4.0.1` | the vendored Cordis line (`latest` 4.0.1; `next` 4.0.1-rc.4). `@deepseek-ai/dsh@0.1.0-rc.6` itself depends on `^4.0.1`. |
| `@deepseek-ai/dsh-tools` | `^0.1.0-rc.6` | `next` line; bare `latest` is the stale `0.0.1-rc.1` line |
| `@deepseek-ai/schemastery` | `^3.18.1` | the vendored Schemastery line (`latest` 3.18.1; `next` 3.18.1-rc.4) |

> **Deviation from the Phase 2 brief:** the brief's stated
> `@deepseek-ai/cordis@0.1.0-rc.6` and `@deepseek-ai/schemastery@0.1.0-rc.6` do
> NOT exist on npm. Cordis and Schemastery use their own version lines
> (`4.x` / `3.x`); only the `dsh-*` packages version on `0.1.0-rc.6`. The
> ranges above are the ones that resolve and match the deployed CLI.

Toolchain: Node `^22.19.0 || >=24.0.0`, pnpm `11.7.0` (via `packageManager` +
corepack), TypeScript `^6.0.3`, `@types/node` `^22.20.0`. `.npmrc` sets
`save-exact=true`.

## 9. Profile manifest

`profile/package.json` carries:

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@dh-multiagents/bundle"
    ]
  }
}
```

`profile/` also holds `cordis.patch.yml` (user patch layer) and `settings.yaml`
(the `$DSH_HOME/settings.yaml`-style settings document) — both commented stubs
in Phase 2, filled in Phase 9.

Layer precedence (bottom → top): bundle patches in `dsh.profile.bundles` order
→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`
overlays → telemetry/preset-root overlays. Later layers win per row; a patch
replaces a row's whole `config`.
