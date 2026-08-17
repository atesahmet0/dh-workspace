# dh-multiagents

Multi-agent orchestration for the DeepSeek Harness (dsh). A team of role-bound agents — plan, build, explore, researcher, coder, scribe, reviewer — with tools enforced by a runtime capability matrix.

## Why dh-multiagents?

- **Plan-first** — read-only orchestrators delegate, never write code themselves.
- **Enforced, not suggested** — each preset's tool allow-list is applied via `tools.restrict`, so a plan agent physically can't run bash.
- **Auditable delegation** — every `delegate` call persists an id (e.g. `daring-pearl-elk`) with a result file on disk.
- **Zero-config install** — one command, presets + skills wired automatically.

## Installation

Requires Node ≥ 22.19 and a dsh install (`@deepseek-ai/dsh@0.1.0-rc.6`).

```bash
dsh plugin --profile <name> init
dsh plugin --profile <name> add @dh-multiagents/bundle
```

> Presets are mirrored automatically at every boot (the plugin copies them
> into `$DSH_HOME/.agent-presets/`), so there is no install-time step.

> **Fresh dsh CLI (npm 11):** npm 11 blocks dependency install scripts by
> default — the harness's own native deps (`node-pty`, `dsh-subprocess-local`,
> `koffi`, `protobufjs`) are gated too. Run `npm install-scripts approve` for
> them before headless mode will boot.

## Quick Start

> [!IMPORTANT]
> **Select `Plan` or `Build` at the start of your session:**
> In the Web or TUI interface, select either the **`plan`** or **`build`** preset in the preset picker at the beginning of your session:
> - **`plan`**: Use when starting a task to research the codebase and write an implementation plan (delegates to `explore` and `researcher`).
> - **`build`**: Use to execute an approved plan (delegates to `coder`, `scribe`, and `reviewer` with worktrees).
>
> Only `plan` and `build` act as orchestrators. The subagent presets (`explore`, `researcher`, `coder`, `scribe`, `reviewer`) are spawned automatically via `delegate` and should not be selected as top-level sessions.

```bash
# headless mode needs the headless bundle (add once)
dsh plugin --profile <name> add @deepseek-ai/dsh-headless

DEEPSEEK_API_KEY=... dsh --profile <name> headless \
  "Use plan_save to save a plan titled '# P' for project 'demo'. Then delegate '1+1?' to the researcher and report its answer."
```

For full orchestration (delegate/build), use the **tui** or **web** profile — headless sessions are preset-less by design, so `delegate` is rejected there (only `plan`/`build` presets may delegate).

## What you get

| Preset | Role | Notable tools |
|---|---|---|
| `plan` | Read-only orchestrator | plan_save/read, delegate → explore/researcher |
| `build` | Read-only orchestrator | delegate → coder/scribe/reviewer, worktrees |
| `explore` | Codebase explorer | read, glob, grep |
| `researcher` | Web researcher | web_search, read |
| `coder` | Implementer | bash, edit, write, worktrees |
| `scribe` | Docs writer | edit, write, read |
| `reviewer` | Read-only reviewer | read, glob, grep |

Plus 5 philosophy skills (`code-philosophy`, `code-review`, `plan-review`, `plan-protocol`, `frontend-philosophy`) loaded into every session.

## Runtime behavior

- Delegations persist as `$DSH_HOME/workspace/<project>/delegations/<id>.md` + `<id>.result.txt` — auditable after the fact.
- Only `plan`/`build` may delegate; plan → explore/researcher, build → +coder/scribe/reviewer. No delegation from inside a subagent (anti-recursion).
- Children inherit the parent's model selection.

## Development

```bash
pnpm install && pnpm -r build
```

- **Naming contract:** identifiers are locked in `DESIGN.md` — change it there first, never in code alone.
- **Presets/skills:** add `presets/<name>/` + a `CAPABILITY_MATRIX` entry (dh-common), or `skills/<name>/SKILL.md` (dh-philosophy).
- **Publishing:** bump versions, then `pnpm pack` and publish the tarballs — plain `npm publish` leaves `workspace:*` unresolved (broke 0.1.0).

## License

MIT
