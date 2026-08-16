> **STATUS: RESOLVED in current code (and compiled `lib/`).** The bug described
> below is fixed: `restrictPresetTools` now filters the matrix allow-list to the
> deployment's `restrictableNames` and skips non-restrictable (agent-local) tools
> with a warning instead of throwing; `confinePath` uses `realpathLoose` so a
> not-yet-created workspace dir no longer surfaces a raw `ENOENT`. This file is
> retained as an archival record of the bug and its fix.

# Issue: subagent creation dies with `tools.restrict() names unknown global tools`

## Bug report (user, ds-workspace runtime)

Running a session against a repo (`vbar-temp`), the agent delegated to the `explore`
subagent. Every delegation/subagent call fails:

```
Error: tools.restrict() names unknown global tools "read", "glob", "grep", "read_image";
known global tools: delegate, delegation_list, delegation_read, plan_read, plan_save,
worktree_create, worktree_delete
```

Same failure for every other preset:
- `researcher`: unknown global tools `web_search`, `read`, `glob`, `grep`
- `coder`: unknown global tools `bash`, `edit`, `write`, `read`, `glob`, `grep`,
  `read_image`, `str_replace_editor`, `skill`, `todo_write`

So delegation is completely broken in that runtime: plan agents cannot spawn any
subagent, hence cannot explore/research/implement.

Secondary symptom after the delegate failures (the agent probed the persisted-plan
tools as a fallback):

```
Error: ENOENT: no such file or directory, lstat '/Users/ates/.dsh/workspace/vbar-temp'
```

## Root cause (confirmed)

`restrictPresetTools()` in `packages/dh-common/src/index.ts` calls
`agentCtx.tools.restrict({ allow: CAPABILITY_MATRIX[preset] })`. The dsh tools
registry (`@deepseek-ai/dsh-tools`, `restrict()` in `lib/index.js` ~line 2772)
VALIDATES every allow/deny name against the scope's `restrictableNames` and THROWS
on names that are not restrictable in that deployment:

```
if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${...}`)
```

`restrictableNames` is built only from the GLOBAL + ancestor layers' registered
tools (`view(scope)` in dsh-tools). In the user's runtime the global toolset is
just the 7 workspace tools (delegate, delegation_list, delegation_read, plan_read,
plan_save, worktree_create, worktree_delete) — the standard harness file/bash/web
tools are registered per-agent (own scope layer), which is exactly the case the
error message covers: scope-local names are visible but NOT restrictable, and
`restrict()` fails when you name them.

So `CAPABILITY_MATRIX` (which names read/glob/grep/bash/edit/write/web_search/...)
is enforced against a toolset the deployment doesn't expose as restrictable
globals. Every preset-owned child creation throws in the setup window, before the
child is published.

Secondary root cause: `confinePath()` in dh-common calls `realpathSync(baseDir)`
(line ~86) unguarded. When the project workspace dir (`$DSH_HOME/workspace/<id>`)
has never been created (fresh project, no plan_save yet), `plan_read` and
`delegation_list` surface a raw `ENOENT` instead of a clean "no plan found" /
empty-list result.

## Acceptance criteria

1. `delegate` to `explore` / `researcher` / `coder` / `scribe` / `reviewer`
   succeeds in a runtime whose restrictable global toolset is only the 7 workspace
   tools. Child agents are created, run, and return results. No
   `tools.restrict() names unknown global tools` error anywhere.
2. Capability enforcement still works where it can: when a matrix name IS a
   restrictable global in the deployment, it is still enforced (a plan agent still
   cannot run bash; explore still cannot write). Missing/scope-local matrix names
   are skipped with a warning, never a throw.
3. A preset whose entire allow-list is unavailable degrades to a warning + no
   restriction (NOT "hide every tool" — an empty restriction would break the
   child; do not restrict to nothing).
4. Foreign/unknown presets still pass through unrestricted with a warning (the
   existing behavior must not regress — see `restrictPresetTools` current code:
   unknown preset -> warn + no-op disposer; known preset with empty allow-list ->
   still throw, that is a config bug in our own matrix).
5. `plan_read` on a project with no existing `$DSH_HOME/workspace/<id>` dir
   returns the clean "no plan found" error (or empty result), never a raw ENOENT.
   `delegation_list` on a project with no delegations dir returns an empty list,
   never ENOENT.
6. No behavioral change when the deployment DOES expose the full standard global
   toolset (the current headless/web validation setups): matrix enforcement stays
   exact.

## Repo conventions (must follow)

- Naming contract: identifiers are locked in `DESIGN.md` — change it there first,
  never in code alone. Check DESIGN.md for any capability-matrix/tool-name
  identifiers before touching them.
- Internal deps stay `workspace:*` in source. `pnpm pack` rewrites at pack time.
- No automated tests for this repo (declined); validation is a live harness run.
- Docs/README: lean, punchy, no emojis.
- Version bumps: the changed package (dh-common) is a dependency of every other
  package → bump ALL dependents + the bundle per the repo's release rules
  (README Development section; see git history for the pattern).

## Validation expectation (your report must cover)

- Build: `pnpm -r build` passes.
- Describe exactly how you verified acceptance criteria 1–6 (what you ran, what
  you observed). If you could not verify something live, say so explicitly.
- Do not fabricate results. An honest "could not verify X" is better than a claim.
