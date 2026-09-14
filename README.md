<div align="center">

![t-plan banner](https://raw.githubusercontent.com/noguerol/t-plan/main/docs/banner.jpeg)

</div>

# t-plan — Implementation Plan Tracking for pi

t-plan keeps a live, persistent implementation plan for every project. It auto-detects plans from the model's output, tracks progress in real time as the model works, renders a compact animated TUI widget, and maintains a **single unified plan file per project** in your working directory — so your plan survives restarts, session switches and compaction.

The model gets a `plan_manager` tool plus automatic plan-context injection, so it can create, update and complete tasks itself. Progress detection also works without any tool calls: the extension reads the model's natural language (English, Spanish **and Mandarin Chinese**) and its tool activity to mark tasks in progress and done.

**One plan file per project:** the file is named `${prefix}_<title-slug>.md` (e.g. `plan_my-app.md`) — the session id is never part of the name. Every pi session working in the same directory reads and updates the *same* file, so the task history is unique instead of multiplying into one file per session. The file also records which sessions worked on it — see [The unified plan file](#the-unified-plan-file).

**Trimegisto integration:** with Trimegisto mode enabled, every task is classified by complexity and assigned a tier — **t1** (complex → deep thinking), **t2** (medium → solver), **t3** (simple → mechanical) — so the model launches each task on the right agent tier. Task timers show a live `HH:MM:SS` counter for every in-progress task.

## What's new

- **v1.3.0 — one plan file, no more session copies** — the plan file is no longer session-scoped: the session id is gone from the filename and there is **one plan file per project**, kept across sessions. Any session started in the same directory adopts the plan already on disk, so task history stops multiplying into `plan_<title>_<session>.md` copies. The plan file now also carries a **Sessions section** recording which pi sessions worked on it (id, first/last seen, optional title). Legacy session-scoped files are still detected and are renamed to the unified name when they match the project or when you load them, and `.gitignore` now ignores `<prefix>_*.md`. Task lines now persist their stable `#ref` (`#3. …`), so task identity, statuses and session history all survive a reload. If another pi session edits the file between our writes, that session's history is merged into the `## 🗂 Sessions` section so no session record is lost, and a warning notes that task state remains last-write-wins.
- **v1.2.1 — same wrap-up closers in English** — the new session-closers from v1.2.0 are language-mirrored: “Already committed and pushed”, “The fix is closed and deployed”, “Working tree is clean, no pending changes”, “All committed and pushed to main”, “already published”, “Resolved. Everything is wrapped up.”, and line-start “Fixed ✅…” / “Done.” all conclude a session now, with the same “not yet / not deployed / …but the deploy is pending” vetoes. (EN was already the core language of the fuzzy detector; this closes the gap for the exact equivalents that were failing in real sessions.)
- **v1.2.0 — no more tasks stuck “in progress” with the timer running** — real sessions still left finished tasks spinning: (a) a summary with three numbered diagnosis points plus a cue word like “actualizados” made the plan reconciler add **phantom tasks** from plain prose; (b) real wrap-up sentences (“Ya estaba commiteado y pusheado…”, “Working tree: limpio, sin cambios pendientes.”, “No queda nada pendiente por commitear ni pushear.”, “está cerrado y desplegado”, “ya publicado”, “Arreglado ✅…”) never matched any completion detector; (c) when the agent run settled normally the model is **idle**, but tasks it had started stayed `in_progress` forever with the `HH:MM:SS` timer counting idle time — across messages, unrelated runs and even session restarts. Fixed: plan refreshes now require **real plan structure** (headings/checkboxes) so prose never spawns tasks; new **wrap-up patterns** recognize the closers real sessions produce (imperfect tense “estaba”, double-m “commiteado”, git-clean prose, “no queda nada pendiente”) with a negation veto (“no está hecho todavía” never concludes); on a normal settle tasks nobody worked on and no longer mentions revert to `pending` (timer stops), and restoring a session parks stale `in_progress` tasks instead of resuming old timers. 43 tests green.
- **v1.1.0 — no more "done-but-pending" tasks** — completed work used to stay pending because (a) `agent_settled` reset every in-progress task to pending at the end of *any* run (even successful ones), (b) the fuzzy detector dropped sentences over 300 chars, required a completion verb that was missing for ~20 Spanish participles, and failed by a floating-point epsilon on `0.55`, (c) real tool activity (edited files, run tests) never completed anything, (d) `[DONE:1,2,3]` only marked the first id, (e) task numbers shifted mid-run when tasks were removed, (f) only 10 pending tasks were injected into the model context. Fixed: abort-aware settle (only interrupted runs pause), clause-level detection with an epsilon-safe threshold and a full participle set, deterministic **tool-evidence completion**, multi-id/range/`all` `[DONE:…]`, stable **#refs** that never renumber, the full plan injected with refs, and per-task (never bulk) touch tracking so conclusions drop only what nobody acted on.
- **Stable task refs** — every task carries a `#ref` assigned once and never renumbered (`[DONE:#3]`, `task_id="3"`, `task_id="2,3"`, `task_id="2-4"`, `task_id="all"`). Display order may change; refs don't.
- **Plan files are private — never commit or publish them** — t-plan now enforces this in three ways: it keeps the pattern `<prefix>_*.md` (which covers unified and legacy session-scoped names, and adds legacy `plan.md` when the prefix is `plan`) in your `.gitignore` automatically, it instructs the model never to `git add`/commit/publish plan files, and every generated plan file carries a private-runtime-state marker.
- **Mandarin Chinese support** — automatic language detection now recognizes Mandarin/Chinese text and localizes auto-generated plan titles as `{project} 计划`.
- **Chinese plan parsing** — t-plan detects headings and task formats such as `## 计划`, `1、任务`, `## 步骤 1：...`, and status groups like `已完成`, `进行中`, `待办`, and `阻塞`.
- **Trilingual fuzzy progress detection** — Mandarin completion/start/removal/conclusion phrases like `已完成`, `正在`, `移除`, `不再需要`, and `全部完成` now work alongside English and Spanish.
- **Trimegisto tier classification in Chinese** — Mandarin task keywords feed the `t1`/`t2`/`t3` heuristic too.

---

## Features

- **Auto-detect plans** from model output — numbered lists, checkboxes, step headers, plan sections
- **Unified plan file** — `plan_<title-slug>.md`: one file per project, no session id in the name and no per-session copies
- **Session history in the file** — a `## 🗂 Sessions` section records which pi sessions worked on the plan (first/last seen, optional title, newest first, capped at 20)
- **Cross-session continuity** — a new session in the same directory continues the plan already on disk; legacy session-scoped files are adopted and renamed to the unified name instead of multiplying
- **Localized plan title** — `{project} Plan` / `Plan de {project}` / `{project} 计划` following the conversation language; shown in the widget and used in the file name
- **Live TUI widget** — compact, animated, always-visible progress above or below the editor
- **Automatic progress tracking** — fuzzy trilingual (EN/ES/ZH Mandarin) matching of completion/starting/removal language plus tool-call evidence; no `[DONE:n]` markers required
- **Continuous plan refresh** — reconciles revised/updated/remaining plans the model publishes mid-project (new, renamed, split and removed tasks)
- **Active-task invariant** — `in_progress` means *right now*: when the agent run settles, stale active tasks revert to pending
- **Work-conclusion invariant** — when the model concludes the whole work, nothing is left active or pending
- **Parallel agent tracking** — tasks spawned for sub-agents are tracked and labeled per agent
- **Trimegisto mode** — complexity-based tier assignment (t1/t2/t3) with availability-aware fallback to `active` (t0)
- **Task timers** — live `HH:MM:SS` elapsed counter on in-progress tasks (configurable)
- **Manual task management** — `/task` command family for full control
- **Session persistence** — state survives restarts and session switches; global preferences persist in `~/.pi/agent/t-plan/config.json`

## Install

t-plan is a [pi package](https://pi.dev/packages): one extension (`src/index.ts`) declared in `package.json`.

```bash
# From GitHub
pi install git:github.com/noguerol/t-plan

# Pin a tag/commit (refs are never moved by `pi update`)
pi install git:github.com/noguerol/t-plan@v1.0.0

# Local checkout (development)
pi install /path/to/t-plan

# Try it for one run only, without installing
pi -e git:github.com/noguerol/t-plan
```

```bash
pi list                    # show installed packages
pi remove git:github.com/noguerol/t-plan
```

> **Security:** pi packages run with full system access — extensions execute arbitrary code. Install only packages you trust and review the source.

**Requirements:** a working pi installation. No API keys, external services or extra dependencies — the extension only uses pi's bundled libraries and Node.js built-ins.

## Quick Start

1. Start (or continue) a conversation about a multi-step project.
2. The model produces a plan — a numbered list, checkboxes or a `## Plan` section. t-plan detects it automatically and creates the task list.
3. Watch the widget: tasks turn 🔄 in progress (with a live timer) as the model works on them and ✅ done as they complete — detected from its responses and tool activity.
4. The project's plan file (`plan_<title-slug>.md`, e.g. `plan_myapp.md`) appears in your working directory and stays up to date — the same file is continued by every later session.
5. Correct or drive anything manually at any time:

```
/task add Write integration tests
/task start 2
/task done 2
```

The extension is enabled by default. Toggle it anytime with `/t-plan` or `Ctrl+Alt+P`.

## The unified plan file

One plan file per project, maintained across sessions — no session id in the name:

```
<prefix>_<title-slug>.md      e.g. plan_myapp.md
```

- **Title** — auto-derived from the working directory name in the conversation's language (English: `myapp Plan`, Spanish: `Plan de myapp`, Mandarin: `myapp 计划`). Change it anytime with `/t-plan new` (which also resets the task list) — custom titles stop being auto-overwritten. Renaming the title writes the plan under the new name and leaves the previous file on disk.
- **One file, every session** — a new pi session in the same directory adopts the tasks already on disk and keeps writing the same file; resuming a session brings its plan back too. Two pi processes in one directory share the same plan instead of producing `plan_myapp_01a048c3.md` and `plan_myapp_01a0493a.md`.
- **One writer at a time** — the unified file is last-write-wins. Work on a project from a single pi session at a time; a second concurrent session in the same directory can overwrite the first one's latest state on disk (each session still keeps its own plan state in the session log, so resuming it recovers that session's view).
- **Concurrent sessions keep their session history** — if the unified file was modified by another pi session between our writes, t-plan merges that session's history into the `## 🗂 Sessions` section so no session record is lost, and warns that task state remains last-write-wins.
- **Sessions section** — the file includes a `## 🗂 Sessions` section (written before the footer) listing the pi sessions that worked on it (session id, first/last seen timestamps and an optional title), newest first, capped at the 20 most recent. The plan file therefore carries a short runtime history, not source.
- **Private by design — never commit or publish plan files.** Plan files are runtime state, not source: t-plan keeps the pattern `<prefix>_*.md` (plus `plan.md` when the prefix is `plan`) in your `.gitignore` automatically — best-effort, and only inside a git working tree — and the model is explicitly instructed never to `git add`, commit, force-add or publish them. If you commit or share plan files, you leak session-internal state.
- **Load a plan.** `/t-plan load` lists every plan file in the directory as `1. <title> · <n> tasks · <date>`, marking the current project file `← current` and old session-scoped files `(legacy)`. Picking one adopts its title, tasks and session history into the current session, and the extension then writes the unified file. Legacy candidates keep their session id as a hint — the extension still tells you how to jump back with `pi --session <id>`.
- **Legacy files are migrated, not duplicated.** A session-scoped `plan_<slug>_<session-id>.md` (or `plan_<slug>_noid.md`) is still detected and read; when it matches the current project title (or you load it), it is **renamed** to `plan_<slug>.md` and becomes *the* unified file (the most recently modified matching legacy file is adopted first).
- **Purge** (`/t-plan purge`) deletes all tasks, resets the plan state and removes the project's plan file.

## Trimegisto Mode

[Trimegisto](https://github.com/noguerol/trimegisto) turns pi into a multi-agent runtime with four tiers. With Trimegisto mode ON (`/t-plan config` → `Trimegisto mode`), t-plan applies trimegisto's own role separation — *"T1 plans, T2 solves, T3 executes"* — to every task:

| Tier | Badge | Complexity | Typical work |
|------|-------|------------|--------------|
| `t1` | `[t1]` (complex) | High | Architecture, deep analysis, refactors, migrations, security, strategy |
| `t2` | `[t2]` (medium) | Medium | Implementation, debugging, code review, integrations, tests |
| `t3` | `[t3]` (simple) | Low | Parsing, formatting, translations, renames, docs, conversions |
| `t0` | `[t0]` (active) | fallback | Default worker tier — used when the assigned tier is unavailable |

- **Auto-classification** — new tasks are classified by a trilingual (EN/ES/ZH Mandarin) weighted keyword heuristic. Ties and unknown texts land on `t2` (the catch-all implementation tier).
- **Manual override** — `/task tier 3 t1` or the `tier` parameter of `plan_manager` (`"t0" | "t1" | "t2" | "t3" | "active"`).
- **Availability-aware** — the extension reads `~/.pi/agent/trimegisto/config.json` and knows which tiers are actually spawnable (enabled + model configured, respecting `spawnOnlyOnActive`). Tasks assigned to an unavailable tier fall back to `t0` (`active`), so plans stay executable.
- **LLM guidance** — the injected plan context lists each task's effective tier and instructs the model to launch tasks on their tier with the `trimegisto` tool, batching independent tasks in one call.
- **Everywhere** — the widget shows colored `[tN]` badges plus a header distribution (`t1×1 t2×3 t3×2`), the plan file shows `(→ tN)` per task, and `/t-plan show` + `plan_manager list` show `→ tN`.

## Task Timers

Every in-progress task can show a live `HH:MM:SS` counter since it started (spinner, badge and timer all update in real time). Completed tasks record their total time in the plan file as `(took HH:MM:SS)`. Toggle with `/t-plan config` → `Task timers`.

## Commands

### `/t-plan` — plan management

| Command | Description |
|---------|-------------|
| `/t-plan` | Toggle plan tracking on/off |
| `/t-plan config` | Open the configuration menu |
| `/t-plan on` / `/t-plan off` | Enable/disable tracking |
| `/t-plan show` | Display current plan status |
| `/t-plan new` | Create a new (empty) plan |
| `/t-plan load` | List the project's plan files (legacy ones highlighted) and load one into the current session |
| `/t-plan save` | Save tasks to the project's plan file |
| `/t-plan clear` | Remove all tasks from the live plan (the plan file is left as-is) |
| `/t-plan purge` | Delete all tasks, reset state and remove the project's plan file |

### `/task` — manual task management

| Command | Description |
|---------|-------------|
| `/task add [text]` | Add a new task |
| `/task done [id]` | Mark a task as completed |
| `/task remove [id]` | Remove a task |
| `/task edit [id]` | Edit a task's text |
| `/task move [id] [n]` | Move a task to position n |
| `/task start [id]` | Mark a task as in progress |
| `/task block [id] [reason]` | Mark a task as blocked |
| `/task tier [id] [t0-t3]` | Set the trimegisto tier of a task |

**Keyboard shortcut:** `Ctrl+Alt+P` toggles plan tracking.

### Task identification

Commands accept any of:

- **Stable ref** — `#3` / `3` (never renumbered when other tasks are removed)
- **List / range / all** — `task_id="2,3"`, `"2-4"`, `"all"`, `[DONE:2,3]`, `[DONE:2-4]`
- **Task ID** — the internal unique ID (e.g. `task_1234_abc`)
- **Text** — exact, substring, or fuzzy best match (`task_id="JWT auth"` finds the JWT task)

If nothing matches, `plan_manager` returns the current ref list so the model can retry in the same turn. Omit the identifier and the extension shows an interactive picker.

## How Progress Detection Works

The model rarely emits explicit markers, so the extension infers progress after every assistant turn from three signal classes:

- **Explicit markers** — `[DONE:n]` (now multi-id: `[DONE:1,3]`, `[DONE:2-4]`, `[DONE:all]`, `[DONE:#3]`), done checkboxes (`- [x] …`, `✅ …`, `✔️ …`)
- **Natural language** — completion language (EN/ES/ZH participles including *actualizado, escrito, probado, verificado, desplegado, configurado, refactorizado, migrado, validado, integrado, cubierto, funciona, corregido…*), starting language, removal language and whole-work conclusions, matched per clause (long summaries are split by clause, never discarded) with token overlap, light stemming, Mandarin CJK shingles and ES/ZH↔EN synonym mapping (synonyms are now resolved **before** stemming, so `terminado↔finished`, `eliminar↔remove`, `guardar↔save` all match)
- **Tool evidence** — deterministic and language-independent: every `tool_result` records the exact paths/commands used (edits and writes mutate; runs of `vitest`/`jest`/`tsc`… count as test evidence). Several tasks can advance per turn, and tasks whose artefacts were genuinely touched are completed when the run settles normally

Detection is deliberately **conservative**: weak signals never complete a task, reading a file alone never completes it, and a clause that explicitly says a task *remains pending* excludes it from evidence completion. You can always correct with `/task done N` or the `plan_manager` tool.

### Continuous plan refresh

Long projects produce revised plans. When an assistant message contains an **updated / current / remaining plan**, the extension reconciles it with the live task list:

- Existing tasks keep their IDs, timestamps and completed status where safe
- New tasks are appended; renamed/refined tasks update their text
- Unfinished tasks missing from an explicitly replacement plan are removed
- Status-grouped plan file sections round-trip with their correct statuses

### Invariants

- **Active-task invariant** — `in_progress` means a model is actively working on it *right now*. A run that ends interrupted (`stopReason: "aborted" | "error"`) pauses its active tasks; a normal settle completes the ones with tool evidence or wrap-up language and **parks back to pending** any task that this run neither worked on nor keeps active in its final text — so nothing spins with a running timer while the agent is idle. Restoring a session also parks stale `in_progress` tasks (no timers inherited from a previous session).
- **Work-conclusion invariant** — when the model concludes the entire work ("all done", "todo listo", or the real-life closers "ya estaba commiteado y pusheado", "working tree limpio", "no queda nada pendiente por commitear ni pushear", "está cerrado y desplegado", "Arreglado ✅…"), active tasks are completed, tasks with real evidence are finalized, tasks explicitly left pending stay pending, and only pending tasks nobody ever touched are dropped from the list.

## Widget UI

The widget is designed to stay compact and readable during long projects:

- **At most 5 tasks** shown, with a `... N more` summary line
- **One line per task** — long descriptions are truncated with a single `…` ellipsis
- **Ordering:** in-progress and blocked tasks first (in-progress with an animated braille spinner), then upcoming by priority
- **Completed tasks** are struck through, briefly illuminated, then fade out after ~2.4s
- **Trimegisto mode:** colored `[tN]` badge per task and a header distribution like `📋 Title  2/7 done • 1 active • t1×1 t2×3 t3×2`
- **Timers:** `⏱ HH:MM:SS` next to each in-progress task

## The `plan_manager` Tool

The extension registers a `plan_manager` tool the model can use to maintain the plan itself:

| Action | Description |
|--------|-------------|
| `add` | Add a task (`task_text`, optional `tier`) |
| `complete` | Mark task(s) done — `task_id` accepts `"3"`, `"2,3"`, `"2-4"`, `"all"` or task text |
| `start` | Mark a task in progress (`task_id`) |
| `block` | Mark a task blocked (`task_id`, optional `notes`) |
| `update` | Change text/status/notes/tier (`task_id`, `task_text`, `status`, `notes`, `tier`) |
| `remove` | Remove task(s) (`task_id`) |
| `list` | Return the current plan state |

Task status also updates automatically from the model's language and tool activity, so the plan stays in sync even when the model never calls the tool.

## Plan File Format

The extension maintains one plan file per project in your working directory — shared and continued across sessions:

```markdown
# Project Plan

## Status: 3/7 completed

- 🔄 In progress: 2
- ⏳ Pending: 2
- ✅ Completed: 3

## 🔄 In Progress

- [ ] #1. Implement authentication module ⏱ 00:04:12 (→ t2) (agent: auth-worker)
- [ ] #2. Set up database schema (→ t2)

## ⏳ Pending

- [ ] #3. Create API endpoints (→ t2)
- [ ] #4. Translate error messages (→ t3)

## ✅ Completed

- [x] #5. Initialize project structure (took 00:01:48) (→ t3)

## 🗂 Sessions

- `01a04f9f` — first seen 2026-08-30 00:24:33, last seen 2026-08-30 00:34:53 — "Optimize startup"
- `01a048c3` — first seen 2026-08-29 19:05:21, last seen 2026-08-29 20:10:03

---
*Last updated: 1/1/2026, 12:00:00*
```

The `## 🗂 Sessions` section is written after the last task group and before the footer, only when at least one session has been recorded; sessions are sorted by most recent activity and capped at 20. It is history metadata, not tasks — the parser never turns its entries into tasks.

Each task line carries its stable `#ref` (`#5. Initialize project structure`) so refs, statuses and the task history survive a reload and continue in the next session.

Edit the file by hand if you like — `/t-plan load` parses it back, including the status-group sections, summary counters, stable refs, tier markers, timers and the session history.

## Configuration

Open with `/t-plan config`:

| Option | Default | Description |
|--------|---------|-------------|
| Plan tracking | ON | Enable/disable the extension |
| Auto-detect plans | ON | Detect plans in model output |
| Show widget | ON | Display the task widget |
| Widget placement | aboveEditor | Widget position (above/below editor) |
| Plan file prefix | `plan` | Plan file: `<prefix>_<title-slug>.md` — one per project, never session-scoped. The prefix prompt is labelled `File prefix (<prefix>_<title>.md):` |
| Track agents | ON | Monitor parallel agent tasks |
| Trimegisto mode | OFF | Tier classification + agent assignment per task |
| Task timers | ON | Live `HH:MM:SS` counter on in-progress tasks |
| Tool evidence | ON | Touch files/commands complete or advance tasks |
| Debug log | OFF | Log swallowed errors to `~/.pi/agent/t-plan/debug.log` |
| Animate widget | ON | Spinner on in-progress tasks + completion flash |
| Compact task lines | ON | Truncate each task to a single line |
| Highlight completed | ON | Briefly illuminate completed tasks before hiding them |

Global preferences persist across sessions in `~/.pi/agent/t-plan/config.json` (the newest session value always wins).

## Repository Layout

```
t-plan/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
└── src/
    ├── index.ts        # Extension entry point (registers commands, shortcut, tool, events)
    ├── runtime.ts      # Lazy-loaded extension body (handlers, widget, file I/O, detection)
    ├── types.ts        # Task/state/config types and defaults
    ├── tiers.ts        # Trimegisto tier classification, availability and timers
    └── utils.ts        # Plan parsing, fuzzy matching and reconciliation engine
```

## License

[MIT](LICENSE) © t-plan contributors
