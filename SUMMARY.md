# t-plan startup footprint optimization

## Summary
Reduced the extension's startup footprint by lazy-loading all runtime code
behind `import("./runtime.ts")` so the host only parses ~4.6 KB / 1.1k tokens
of entrypoint on boot, while heavy command handlers, the agent tool, file
operations, plan detection, and tier helpers live behind a single dynamic
import that fires on first use. Exposed strings (package description, command
descriptions, tool description, parameter descriptions, completion entries,
status/notify text, context-injection labels, menu labels) were rewritten in
telegraphic style without changing any public command/tool name, schema key,
or persisted config shape.

## Behavior intentionally unchanged
- Command names: `t-plan`, `task`; shortcut: `Ctrl+Alt+P`; tool: `plan_manager`.
- Tool parameters (action enum + task_text / task_id / status / notes / tier) and
  description semantics.
- Persisted config keys (`planFilePrefix`, `trimegisto`, `showTimers`, …) and
  persistence schema (`plan-state` custom entry, global config JSON shape).
- Trimegisto tier values (`t0`/`t1`/`t2`/`t3` and `active`), classification
  rules, and tier-availability fallback.
- Plan file name pattern `<prefix>_<title>_<sessionId>.md` and `.gitignore`
  pattern enforcement.
- All event handlers (`session_start`, `before_agent_start`, `turn_end`,
  `agent_end`, `agent_settled`, `session_shutdown`).
- All help/notify text meaning (e.g. `Disabled` → `Plan OFF`,
  `Completed: foo` → `✓ foo`, but still reports completion).

## Files touched
- `src/index.ts` — new minimal entrypoint (91 lines, registers
  commands/tool/shortcut/events, defers everything else to lazy runtime).
- `src/runtime.ts` — renamed from `src/index.ts`; contains the original
  extension body, with all `pi.register*` / `pi.on` calls replaced by exported
  handler factories returned from `createPlanRuntime(pi)`.
- `src/types.ts`, `src/tiers.ts`, `src/utils.ts` — only comment and inline
  doc-block removal; no runtime semantics changed.
- `package.json` — telemetry description shortened.

## Before / after footprint (chars, est. tokens via `chars / 4`)

| File / surface                     | Before chars | Before tok | After chars | After tok | Δ chars | Δ tok |
| ---------------------------------- | -----------: | ---------: | ----------: | --------: | ------: | ----: |
| `src/index.ts` (startup)           |       69,777 |     17,444 |       4,559 |     1,140 | -65,218 | -16,305 |
| `src/runtime.ts` (lazy)            |             |            |      54,338 |    13,585 | +54,338 | +13,585 |
| `src/types.ts`                     |        2,618 |        655 |       2,576 |       644 |     -42 |    -11 |
| `src/tiers.ts`                     |        8,857 |      2,214 |       5,984 |     1,496 |  -2,873 |   -718 |
| `src/utils.ts`                     |       44,812 |     11,203 |      38,026 |     9,507 |  -6,786 |  -1,696 |
| **relevant source total**          |   **126,064** |  **31,516** |  **105,483** | **26,371** | **-20,581** | **-5,145** |
| `package.json`                     |        1,301 |        325 |       1,023 |       256 |    -278 |    -69 |
| `package.json` description         |          378 |         95 |         100 |        25 |    -278 |    -70 |
| **Startup-loaded footprint**       |   **126,064** |  **31,516** |     **4,559** |  **1,140** | **-121,505** | **-30,376** |

Startup-loaded footprint = the entrypoint plus its `static` imports.
The new `src/index.ts` imports only `extension-api` type, `StringEnum`,
`Key`, and `Type` (plus a `import("./runtime.ts")` dynamic call), so the
host loads **~96% fewer chars / ~96% fewer estimated tokens** at startup.
The remaining 105 KB / ~26k tokens now resolves lazily on first command,
event, or tool invocation.

## Lazy-loaded modules
All previously static imports in the entrypoint are now behind a single
dynamic `import("./runtime.ts")` in `src/index.ts`:

- `./runtime.ts` (handlers, persistence, file I/O, widget code, plan context,
  auto-detection logic, tier integration, command bodies).
- `./types.ts` (`DEFAULT_CONFIG`, `DEFAULT_STATE`, `SPINNER_FRAMES`) — pulled
  in transitively via `runtime.ts`.
- `./tiers.ts` (`classifyTask`, `isTierAvailable`, `readTrimegistoConfig`,
  `resolveEffectiveTier`, `tierToToolValue`, `toolValueToTier`,
  `formatElapsed`, `completedTimerText`, and the weighted keyword classifier).
- `./utils.ts` (plan extraction, markdown serialization, fuzzy progress
  detection, language detection, slug helpers, file-name builder).
- `node:fs/promises`, `node:path`, `node:os` — only used inside `runtime.ts`.

Note: `./runtime.ts` and its downstream modules are still loaded together on
first interaction; splitting further (e.g. separating file I/O vs. detection)
would add another layer of churn without measurably shrinking boot because
the entrypoint never pulls them in anymore.

## Compressed runtime strings
- Command descriptions:
  - `t-plan`: `"Toggle t-plan tracking or show plan status"` → `"Toggle/show t-plan"`.
  - `task`: `"Manage plan tasks (add, done, remove, edit, move)"` →
    `"Manage plan tasks"`.
  - Shortcut: `"Toggle plan tracking"` → `"Toggle t-plan"`.
- Tool description / snippet / guidelines:
  - tool description trimmed from two long sentences to one telegraphic line.
  - `promptSnippet` collapsed to a single phrase.
  - Four `promptGuidelines` collapsed from full sentences to bullet-style
    directives; safety rule (private plan files, no commit/force-add) kept.
- Argument-completion descriptions rewritten to one-word labels
  (`"Enable"`, `"Disable"`, `"Load"`, `"Purge"`, `"Add"`, `"Done"`,
  `"Set tier"`, …).
- Parameter descriptions shortened while preserving meaning:
  - `task_text`: `"Task description (for add/update)"` →
    `"Task text (add/update)"`.
  - `task_id`: `"Task ID or order number (for complete/update/remove/start/block)"` →
    `"Task id/order (complete/update/remove/start/block)"`.
  - `notes`: `"Additional notes"` → `"Notes"`.
  - `tier`: collapsed to `"Trimegisto tier; t0/active fallback. Auto-classified if omitted."`.

## Compressed injected/advisory context
The `[PLAN]` block now uses compact headers and inline rules:

- Header `[PLAN TRACKING ACTIVE]` → `[PLAN]`; second blank-and-title line
  merged onto one line.
- Long privacy paragraph replaced by a single line
  `Private: never git add/commit/publish plan files; gitignore <prefix>_*_[0-9a-zA-Z]*.md; no force-add.`
- Trimegisto block header `[TRIMEGISTO DISTRIBUTION]` → `[TG]`; multi-line
  tier-role table collapsed to one line (`active=t0 default; t1=complex/planning;
  t2=medium/debug/review; t3=simple/mechanical`); batch/complete guidance kept
  inline.
- `Currently in progress` → `Doing`; `Pending tasks` → `Todo`;
  `Completed: N tasks` → `Done: N`.
- `... and N more` → `... +N`.
- Trailing paragraph reduced to one line:
  `Auto-tracks tool activity/responses. Plan changed? use plan_manager add/remove/update. Finish? [DONE:n] or plan_manager complete task_id=n. Starting? name task.`

## Compressed status / notifications
- `Plan tracking enabled/disabled` → `Plan ON/OFF`.
- `Task tracking is disabled. Use /plan on to enable.` → `plan off`.
- `Plan purged: tasks, state, and plan file removed` → `purged`.
- `Plan saved to …` → `Saved`.
- `Task added` → `Added`; `Task updated` → `Updated`; `Task removed` → `Removed`.
- `Completed: <text>` → `✓ <text>`; `Started: <text>` → `▶ <text>`;
  `Blocked: <text>` → `✗ <text>`.
- `Moved to position N` → `→ #N`.
- `T<n> → <tier>` for tier-set action.
- `Loaded N tasks from <file>` → `loaded N`.
- `This plan belongs to session <id> — resume with: pi --session <id>` →
  `session <id>: pi --session <id>`.
- Auto-notes (`autoNotes.push`): refreshed / stale / auto-completed /
  in-progress / concluded messages shortened to `↻ refreshed …`,
  `-N stale`, `+N done`, `N in-progress`, `done: a, b`.

## Compressed serialized context labels
- Config menu labels: each toggle shortened from
  `"Plan tracking: ON/OFF"` to `"Track: ON/OFF"`,
  `"Auto-detect plans: ON/OFF"` → `"Auto-detect: ON/OFF"`,
  `"Show widget: ON/OFF"` → `"Widget: ON/OFF"`,
  `"Task timers: ON/OFF"` → `"Timers: ON/OFF"`,
  `"Animate widget: ON/OFF"` → `"Animate: ON/OFF"`,
  `"Compact task lines: ON/OFF"` → `"Compact: ON/OFF"`,
  `"Highlight completed: ON/OFF"` → `"Highlight: ON/OFF"`.
- Action entries: `"💾 Save plan to file"` → `"💾 Save"`,
  `"📂 Load plan from file"` → `"📂 Load"`,
  `"🗑️ Clear all tasks"` → `"🗑️ Clear"`,
  `"🧹 Purge plan (reset state + delete this session's plan file)"` →
  `"🧹 Purge"`.
- Decision logic in `showConfigMenu` updated to match the new labels.

## Validation
- `esbuild` bundle for both the entrypoint and the runtime module produced
  valid ESM (no parse errors).
- `node --check` passes on both bundled outputs.
- TypeScript compiler not available (no `node_modules`); esbuild's
  TypeScript-aware bundling served as the structural check.
- Command names, tool name, parameter schema, and config keys are byte-for-byte
  identical to the previous public API.

## Lazy-loaded modules list
1. `./runtime.ts` (single dynamic import resolves everything else).
2. `./types.ts` (transitive).
3. `./tiers.ts` (transitive).
4. `./utils.ts` (transitive).
5. `node:fs/promises`, `node:path`, `node:os` (transitive).
