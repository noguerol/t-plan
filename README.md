# t-plan — Implementation Plan Tracking for pi

t-plan keeps a live, persistent implementation plan for every pi session. It auto-detects plans from the model's output, tracks progress in real time as the model works, renders a compact animated TUI widget, and maintains a `plan.md` file in your project directory — so your plan survives restarts, session switches and compaction.

The model gets a `plan_manager` tool plus automatic plan-context injection, so it can create, update and complete tasks itself. Progress detection also works without any tool calls: the extension reads the model's natural language (English **and** Spanish) and its tool activity to mark tasks in progress and done.

**Trimegisto integration:** with Trimegisto mode enabled, every task is classified by complexity and assigned a tier — **t1** (complex → deep thinking), **t2** (medium → solver), **t3** (simple → mechanical) — so the model launches each task on the right agent tier. Task timers show a live `HH:MM:SS` counter for every in-progress task.

---

## Features

- **Auto-detect plans** from model output — numbered lists, checkboxes, step headers, plan sections
- **Live TUI widget** — compact, animated, always-visible progress above or below the editor
- **Persistent `plan.md`** — written to the working directory and kept in sync as tasks progress
- **Automatic progress tracking** — fuzzy bilingual (EN/ES) matching of completion/starting/removal language plus tool-call evidence; no `[DONE:n]` markers required
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
pi install git:github.com/noguerol/plan

# Pin a tag/commit (refs are never moved by `pi update`)
pi install git:github.com/noguerol/plan@v1.0.0

# Local checkout (development)
pi install /path/to/plan

# Try it for one run only, without installing
pi -e git:github.com/noguerol/plan
```

```bash
pi list                    # show installed packages
pi remove git:github.com/noguerol/plan
```

> **Security:** pi packages run with full system access — extensions execute arbitrary code. Install only packages you trust and review the source.

**Requirements:** a working pi installation. No API keys, external services or extra dependencies — the extension only uses pi's bundled libraries and Node.js built-ins.

## Quick Start

1. Start (or continue) a conversation about a multi-step project.
2. The model produces a plan — a numbered list, checkboxes or a `## Plan` section. t-plan detects it automatically and creates the task list.
3. Watch the widget: tasks turn 🔄 in progress (with a live timer) as the model works on them and ✅ done as they complete — detected from its responses and tool activity.
4. `plan.md` appears in your working directory and stays up to date.
5. Correct or drive anything manually at any time:

```
/task add Write integration tests
/task start 2
/task done 2
```

The extension is enabled by default. Toggle it anytime with `/t-plan` or `Ctrl+Alt+P`.

## Trimegisto Mode

[Trimegisto](https://github.com/noguerol/trimegisto) turns pi into a multi-agent runtime with four tiers. With Trimegisto mode ON (`/t-plan config` → `Trimegisto mode`), t-plan applies trimegisto's own role separation — *"T1 plans, T2 solves, T3 executes"* — to every task:

| Tier | Badge | Complexity | Typical work |
|------|-------|------------|--------------|
| `t1` | `[t1]` (complex) | High | Architecture, deep analysis, refactors, migrations, security, strategy |
| `t2` | `[t2]` (medium) | Medium | Implementation, debugging, code review, integrations, tests |
| `t3` | `[t3]` (simple) | Low | Parsing, formatting, translations, renames, docs, conversions |
| `t0` | `[t0]` (active) | fallback | Default worker tier — used when the assigned tier is unavailable |

- **Auto-classification** — new tasks are classified by a bilingual (EN/ES) weighted keyword heuristic. Ties and unknown texts land on `t2` (the catch-all implementation tier).
- **Manual override** — `/task tier 3 t1` or the `tier` parameter of `plan_manager` (`"t0" | "t1" | "t2" | "t3" | "active"`).
- **Availability-aware** — the extension reads `~/.pi/agent/trimegisto/config.json` and knows which tiers are actually spawnable (enabled + model configured, respecting `spawnOnlyOnActive`). Tasks assigned to an unavailable tier fall back to `t0` (`active`), so plans stay executable.
- **LLM guidance** — the injected plan context lists each task's effective tier and instructs the model to launch tasks on their tier with the `trimegisto` tool, batching independent tasks in one call.
- **Everywhere** — the widget shows colored `[tN]` badges plus a header distribution (`t1×1 t2×3 t3×2`), `plan.md` shows `(→ tN)` per task, and `/t-plan show` + `plan_manager list` show `→ tN`.

## Task Timers

Every in-progress task can show a live `HH:MM:SS` counter since it started (spinner, badge and timer all update in real time). Completed tasks record their total time in `plan.md` as `(took HH:MM:SS)`. Toggle with `/t-plan config` → `Task timers`.

## Commands

### `/t-plan` — plan management

| Command | Description |
|---------|-------------|
| `/t-plan` | Toggle plan tracking on/off |
| `/t-plan config` | Open the configuration menu |
| `/t-plan on` / `/t-plan off` | Enable/disable tracking |
| `/t-plan show` | Display current plan status |
| `/t-plan new` | Create a new (empty) plan |
| `/t-plan load` | Load tasks from `plan.md` |
| `/t-plan save` | Save tasks to `plan.md` |
| `/t-plan clear` | Remove all tasks (keep state) |
| `/t-plan purge` | Delete all tasks, reset state and remove `plan.md` |

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

- **Order number** — `/task done 2`
- **Task ID** — the internal unique ID (e.g. `task_1234_abc`)
- **Partial text** — case-insensitive substring of the description

Omit the identifier and the extension shows an interactive picker.

## How Progress Detection Works

The model rarely emits explicit markers, so the extension infers progress after every assistant turn from three signal classes:

- **Explicit markers** — `[DONE:n]` lines and done checkboxes (`- [x] …`, `✅ …`, `✔️ …`)
- **Natural language** — completion language ("implemented", "done", "añadido"…), starting language ("starting", "working on", "empezando"…), removal language ("dropped", "no longer needed"…) and whole-work conclusions ("all done", "todo listo"…), matched fuzzily against task text with token overlap, light stemming and ES↔EN synonym mapping
- **Tool evidence** — tool calls and results of the turn (edited paths, command arguments) matched against each task's distinctive words

Detection is deliberately **conservative**: weak signals never complete a task. You can always correct with `/task done N` or the `plan_manager` tool.

### Continuous plan refresh

Long projects produce revised plans. When an assistant message contains an **updated / current / remaining plan**, the extension reconciles it with the live task list:

- Existing tasks keep their IDs, timestamps and completed status where safe
- New tasks are appended; renamed/refined tasks update their text
- Unfinished tasks missing from an explicitly replacement plan are removed
- Status-grouped `plan.md` sections round-trip with their correct statuses

### Invariants

- **Active-task invariant** — `in_progress` means a model is actively working on it. When the agent run fully settles, finished tasks are marked done and any task still active reverts to pending.
- **Work-conclusion invariant** — when the model concludes the entire work ("all done", "everything is complete"), active tasks are completed and remaining pending/blocked tasks are dropped from the list.

## Widget UI

The widget is designed to stay compact and readable during long projects:

- **At most 5 tasks** shown, with a `... N more` summary line
- **One line per task** — long descriptions are truncated with a single `…` ellipsis
- **Ordering:** in-progress tasks first (animated braille spinner), then blocked, then upcoming by priority
- **Completed tasks** are struck through, briefly illuminated, then fade out after ~2.4s
- **Trimegisto mode:** colored `[tN]` badge per task and a header distribution like `📋 Title  2/7 done • 1 active • t1×1 t2×3 t3×2`
- **Timers:** `⏱ HH:MM:SS` next to each in-progress task

## The `plan_manager` Tool

The extension registers a `plan_manager` tool the model can use to maintain the plan itself:

| Action | Description |
|--------|-------------|
| `add` | Add a task (`task_text`, optional `tier`) |
| `complete` | Mark a task done (`task_id`) |
| `start` | Mark a task in progress (`task_id`) |
| `block` | Mark a task blocked (`task_id`, optional `notes`) |
| `update` | Change text/status/notes/tier (`task_id`, `task_text`, `status`, `notes`, `tier`) |
| `remove` | Remove a task (`task_id`) |
| `list` | Return the current plan state |

Task status also updates automatically from the model's language and tool activity, so the plan stays in sync even when the model never calls the tool.

## `plan.md` Format

The extension maintains a `plan.md` file in your working directory:

```markdown
# Project Plan

## Status: 3/7 completed

- 🔄 In progress: 2
- ⏳ Pending: 2
- ✅ Completed: 3

## 🔄 In Progress

- [ ] Implement authentication module ⏱ 00:04:12 (→ t2) (agent: auth-worker)
- [ ] Set up database schema (→ t2)

## ⏳ Pending

- [ ] Create API endpoints (→ t2)
- [ ] Translate error messages (→ t3)

## ✅ Completed

- [x] Initialize project structure (took 00:01:48) (→ t3)

---
*Last updated: 1/1/2026, 12:00:00*
```

Edit the file by hand if you like — `/t-plan load` parses it back, including the status-group sections, summary counters, tier markers and timers.

## Configuration

Open with `/t-plan config`:

| Option | Default | Description |
|--------|---------|-------------|
| Plan tracking | ON | Enable/disable the extension |
| Auto-detect plans | ON | Detect plans in model output |
| Show widget | ON | Display the task widget |
| Widget placement | aboveEditor | Widget position (above/below editor) |
| Plan filename | `plan.md` | Name of the plan file |
| Track agents | ON | Monitor parallel agent tasks |
| Trimegisto mode | OFF | Tier classification + agent assignment per task |
| Task timers | ON | Live `HH:MM:SS` counter on in-progress tasks |
| Animate widget | ON | Spinner on in-progress tasks + completion flash |
| Compact task lines | ON | Truncate each task to a single line |
| Highlight completed | ON | Briefly illuminate completed tasks before hiding them |

Global preferences persist across sessions in `~/.pi/agent/t-plan/config.json` (the newest session value always wins).

## Repository Layout

```
plan/
├── package.json        # pi package manifest (pi-package)
├── LICENSE             # MIT
├── README.md
└── src/
    ├── index.ts        # Extension entry point (commands, widget, tool, hooks)
    ├── types.ts        # Task/state/config types and defaults
    ├── tiers.ts        # Trimegisto tier classification, availability and timers
    └── utils.ts        # Plan parsing, fuzzy matching and reconciliation engine
```

## License

[MIT](LICENSE) © Javier Noguerol
