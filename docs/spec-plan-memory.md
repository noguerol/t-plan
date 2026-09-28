# Spec-Driven Project Memory (frozen contract v1.7)

Goal: a long project that starts from a spec doc or a long structured prompt must keep
**100% of the original requirements** as first-class, persisted tasks, so context decay,
model switches and interruptions cannot silently drop them. The plan file becomes the
project's global planning memory.

Do not deviate from this contract without updating this file first.

## 1. Concepts

- **SpecSource** — one origin of requirements: a referenced file (`kind:"file"`) or the
  user's structured prompt (`kind:"prompt"`). Stored with a cheap content hash so the
  same source is never ingested twice (and a retracted source stays retracted).
- **PlanRequirement** — one atomic requirement (`R1`, `R2`…), with its source, an anchor
  (section heading or `Lnn`) and the raw text. Stable ids, never renumbered.
- **Lane** — execution horizon of a task: `active` (current timeframe, default),
  `backlog` (long-term queue extracted from the spec), `paused` (deliberately parked).
- **Task traceability** — every seeded task carries `reqs: [R…]` (which requirements it
  covers), `spec` (the literal spec/prompt excerpt, stored *in the task*), `check`
  (acceptance/verification steps) and `verifiedAt`/`verifyNote`.
- **Coverage** — `mapped` = requirement has ≥1 task; `satisfied` = requirement has ≥1
  **done** task. 100% coverage is both levels.
- **Completion gate** — a task derived from a spec (`spec` or `check` present) can only
  be `done` when it is **verified**: `verifiedAt` set by `plan_manager verify`, or the run
  evidence contains a real build/test command (`evidence.testRuns > 0`). Writing code is
  not finishing it.

## 2. src/types.ts (NEW fields — additive, never remove)

```ts
export type TaskLane = "active" | "backlog" | "paused";

export interface SpecSource {
  id: string;                        // "S1", "S2"… stable
  kind: "file" | "prompt";
  ref: string;                       // relative path, or "prompt"
  title?: string;                    // first heading / first line
  hash: string;                      // hashText(content)
  addedAt: number;
  requirementCount: number;
}

export interface PlanRequirement {
  id: string;                        // "R1", "R2"… stable
  sourceId: string;                  // SpecSource.id
  anchor?: string;                   // "§2 Auth" | "L42"
  text: string;                      // atomic requirement text
}
```

`PlanTask` gains (all optional):

```ts
lane?: TaskLane;          // undefined === "active"
reqs?: string[];          // ["R2","R5"]
spec?: string;            // literal excerpt from the prompt/spec (flattened, ≤400 chars)
check?: string[];         // acceptance/verification steps, e.g. ["compiles","tests pass"]
verifiedAt?: number;      // ms epoch, set by plan_manager verify
verifyNote?: string;      // evidence recorded by the model ("npm test → 32 passed")
```

`PlanState` gains:

```ts
specs?: SpecSource[];
requirements?: PlanRequirement[];
```

`PlanConfig` gains (both default `true`):

```ts
specMemory: boolean;      // detect/ingest specs + auto-seed + lanes + [SPEC] context
specReviewGate: boolean;  // block premature "done" and unverified completion
```

## 3. src/spec.ts (NEW module, pure — no runtime imports)

```ts
import type { PlanRequirement, PlanTask, SpecSource, TaskLane } from "./types.ts";

export const SPEC_ACTIVE_WINDOW = 5;   // backlog tasks auto-promoted to the active lane
export const MAX_REQUIREMENTS = 80;    // hard cap per source

export function hashText(text: string): string;
// deterministic short hash (djb2 or sha1 hex slice). Never empty.

export function looksLikeComplexSpec(text: string): boolean;
// true when the text is a spec/long structured request:
//  - a strong keyword: spec|specification|requisitos?|requirements?|acceptance criteria|
//    criterios de aceptación|RF-\d|RNF-\d|MUST|SHALL|DEBE(R[ÁA])?|entregables?|deliverables?
//    OR (>= 8 non-empty lines AND >= 6 structural items (bullet/numbered/heading))
//    OR (>= 1200 chars AND >= 3 markdown headings)
// false for short chatter.

export interface RawRequirement { sourceId: string; anchor?: string; text: string; }

export function extractRequirements(text: string, sourceId: string): RawRequirement[];
// Split by markdown headings; anchor = heading text (or "Lnn" when no heading).
// Collect bullets / numbered items / checkboxes and, in sections without lists,
// sentences carrying a modal or action verb (must/shall/debe/implement/create/add/
// support/validate…). Clean markdown inline, flatten whitespace, min length 12,
// drop status/summary noise, dedupe by requirementSignature, cap MAX_REQUIREMENTS.

export function requirementSignature(text: string): string;
// lowercase, strip punctuation/diacritics, collapse spaces, drop stopwords; used for dedupe.

export function makeSpecSource(id: string, kind: "file"|"prompt", ref: string,
  text: string, requirementCount: number): SpecSource;

export function nextSpecId(specs: SpecSource[] | undefined): string;        // "S"+ (max+1)
export function nextRequirementId(reqs: PlanRequirement[] | undefined): string; // "R"+(max+1)

export interface CoverageReport {
  total: number;
  mapped: number;        // requirement has >=1 task
  satisfied: number;     // requirement has >=1 done task
  percent: number;       // total ? round(satisfied/total*100) : 100
  unmapped: PlanRequirement[];
  unsatisfied: PlanRequirement[];   // every requirement without a done task
}
export function computeCoverage(requirements: PlanRequirement[] | undefined, tasks: PlanTask[]): CoverageReport;

// "".join when no requirements. Otherwise a compact block, e.g.
// [SPEC] 3/12 satisfied · 12/12 mapped (25%)
// gaps: R5 §2 Auth; R7 §3 API; R9 §4 UI
export function formatCoverageContext(requirements: PlanRequirement[] | undefined, tasks: PlanTask[], maxGaps?: number): string;

// A spec-derived task (has spec or check) is satisfied when verifiedAt is set,
// or the run evidence ran a build/test command. Non-spec tasks are always true.
export function taskVerificationRequired(task: PlanTask): boolean;
export function taskVerified(task: PlanTask, testRuns: number): boolean;
// testRuns is the EvidenceIndex.testRuns counter of the current run.
```

`extractRequirements` must be tolerant: malformed input returns `[]`, never throws.

## 4. src/utils.ts (serialization + round-trip)

New exports:

```ts
export interface ParsedSpecs { specs: SpecSource[]; requirements: PlanRequirement[]; }
export function parsePlanSpecs(content: string): ParsedSpecs;
export function laneFromTaskText(text: string): TaskLane | undefined;
export function reqsFromTaskText(text: string): string[] | undefined;
```

Task-line markers (same shape as the existing `(→ t2)` tier marker, so they round-trip):

```
- [ ] #7. Implement OAuth login (→ t2) (lane:backlog) (reqs:R2,R5)
```

- `lane` is written **only** when set and !== `"active"`.
- `reqs` is written only when non-empty.
- Order of suffixes: tier, lane, reqs.

Metadata continuation lines (indented, written right after the owning task line):

```
- [ ] #7. Implement OAuth login (→ t2) (reqs:R2)
  - spec: The system MUST authenticate users via OAuth2 (from S1 §2 Auth)
  - check: compiles | tests pass | behavior matches the spec excerpt
  - verified: 2026-09-24 17:02:11 — npm test → 32 passed
```

- The `spec:` / `check:` / `verified:` continuation is **only** emitted when the field
  exists. `check` is joined with ` | `.
- `extractPlanTasks` MUST recognise indented `spec|check|verified` metadata lines
  (regex: `/^\s{2,}[-*]\s+(spec|check|verified)\s*[:：]\s*(.+)$/i`) **before** the generic
  dash pattern, attach them to the previous task, and never turn them into tasks.
- `extractPlanTasks` MUST skip the `Specs` and `Requirements` sections exactly like it
  already skips `Sessions` (their bullets/checkboxes are not tasks).
- `cleanTaskText` MUST strip `(lane:…)` and `(reqs:…)` markers.

`generatePlanMarkdown` adds, after the task status sections and **before** `## 🗂 Sessions`:

```
## 📋 Specs

- `S1` [file] `specs/app.md` — "App Specification" — 12 requirements — hash:1a2b3c4d

## 🎯 Requirements

- [ ] R1. The system MUST authenticate users (S1 · §2 Auth) (tasks: #7, #8)
- [x] R2. Persist sessions in Postgres (S1 · §3 Data) (tasks: #9)
```

- Requirement checkbox is `[x]` when the requirement is satisfied (≥1 done task).
- `(tasks: #a, #b)` is derived at render time from `tasks[].reqs`; never persisted.
- The `— hash:XXXX` suffix is the content hash of the source; it must round-trip so a
  re-adopted plan never re-ingests the same file and duplicates its requirements.
- `parsePlanSpecs` reads both sections; text may contain parentheses, so parse the
  trailing `(S… · anchor)` and `(tasks: …)` groups first, then what remains is the text.
- `adoptPlanContent` (runtime) must call `parsePlanSpecs` and assign
  `state.specs`/`state.requirements` so the memory survives sessions and model switches.

## 5. src/runtime.ts

### 5.1 Ingestion (in `onBeforeAgentStart`)

When `config.specMemory`:

1. `const prompt = typeof event?.prompt === "string" ? event.prompt : ""`.
2. If `looksLikeComplexSpec(prompt)` → `ingestSpec(prompt, "prompt", "prompt")`.
3. Referenced files are **opt-in** (`config.specIngestFiles`, default off). When ON, scan the
   prompt for paths (`/[\w./-]+\.(?:md|markdown|txt)/gi`), resolve against `ctx.cwd`, reject
   paths escaping `cwd`, read (≤200 KB), and ingest **only if both**
   `looksLikeComplexSpec(content)` **and** `isSpecDocument(rel, content)` pass. A mere
   mention of a notes file must never create a source (RC-1/F-1/F-2).
4. `promoteBacklog()` once.

`isSpecDocument(ref, text)` refuses project memory, plan files, changelogs, ADRs and testing
notes by path, and accepts a file only when its name declares a spec (`spec`, `requirements`,
`prd`…), or the content carries requirement ids (`RF-12`, `REQ-3`, `P0-REQ-1`) or an explicit
`## Requirements` / `## Acceptance criteria` heading. Explicit `plan_manager source` is a user
opt-in and bypasses this gate (but not the normative filter or the caps).

`ingestSpec(text, kind, ref)`:
- no-op if `hashText(text)` already exists in `state.specs` (same source re-sent each turn), or
  if that hash was retracted earlier in the session (`forgottenHashes`);
- `nextSpecId`, `extractRequirements`; if 0 requirements, no-op;
- prune the oldest sources until at most `MAX_SPEC_SOURCES` (8) remain; retracted sources lose
  their requirements and the tasks that only covered them;
- cap the ledger at `MAX_PROJECT_REQUIREMENTS` (200) and push `makeSpecSource(...)` plus each
  requirement with `nextRequirementId`;
- **it does not create a task per requirement.** The requirements are the ledger; the caller's
  `promoteBacklog()` lifts them into the active window (F-4). Each lifted task gets a derived
  short title (`requirementTitle`), the full text as `spec`, `check: defaultChecksFor(...)` and
  `reqs:[id]`;
- remember the count so `onTurnEnd` can notify; write the plan file once.

`defaultChecksFor(text)`: when the text looks like code/feature work
(implement/create/add/endpoint/api/component/fix/refactor/script) →
`["compiles/typechecks","tests pass","behavior matches the spec excerpt"]`;
otherwise `["matches the spec excerpt"]`.

### 5.2 Lanes + rolling promotion

- `promoteBacklog()`: while the **active** lane has fewer than `SPEC_ACTIVE_WINDOW`
  non-done tasks, move the lowest-`order` explicit `backlog` pending task to `active`;
  when there is none, seed `seedNextRequirementTask()` from the requirement ledger. An
  explicit `plan ... lane=backlog|paused` is respected (no immediate promotion).
- Call it after ingestions, after every completion path in `onTurnEnd`, and after
  `plan_manager complete`/`verify`/`forget`.
- `ensureRequirementCoverage()` (self-heal): if a reconciliation or removal leaves a
  requirement without any task, re-seed from the ledger **up to the active-window budget**
  before the review gate, so coverage stays actionable without turning the whole ledger
  into tasks (F-4).
- Active-lane tasks are shown under `Doing:`/`Todo:`. Backlog and paused tasks are shown
  in dedicated blocks so the long-term plan stays visible without polluting the cap.

### 5.3 Injected context (`onBeforeAgentStart`)

Keep every existing line/contract (the footprint tests assert them). Add, before the
final `Rules:` line:

```
[SPEC]
coverage: 3/12 satisfied · 12/12 mapped (25%)
gaps: R5 §2 Auth; R7 §3 API
Backlog (7):
- 🗂 #20. …
Paused: #24
Gate: do NOT conclude while coverage < 100%; the plan is the project memory. Every
spec task needs plan_manager verify (build/test evidence) before complete.
```

- `pending` (the `Todo:` block) excludes `lane:"backlog"` and `lane:"paused"` when
  `config.specMemory` (they get their own blocks), so nothing is hidden.
- The backlog block is capped (40) like `Todo:`.
- The `Gate:` line is emitted only when requirements exist and `satisfied < total`.
- All new blocks are omitted when `config.specMemory` is off or there are no
  requirements/tasks in those lanes, so non-spec plans are byte-for-byte unchanged.

### 5.4 Completion + verification gates (`onTurnEnd`)

- A task with `spec`/`check` **cannot** reach `done` unless `taskVerified(task, evidence.testRuns)`.
- `plan_manager complete` on an unverified spec task returns an error listing `check`
  and asking for `plan_manager verify`.
- In `onTurnEnd`, every auto/evidence/conclusion completion path skips unverified spec
  tasks (keep them pending); `markTaskStatus` itself is not changed.
- When the model concludes (`clauses.conclusion` or generic completion) but coverage is
  `< 100%` (or unverified spec tasks remain) **and** `config.specReviewGate`, do **not**
  run the drop/complete branch. Instead, at most twice per run
  (`gateForced < 2`, reset in `onBeforeAgentStart`), return:

```ts
{ entries: [{ type: "custom_message", customType: "plan-gap",
  content: gapMessage, display: true }], continue: true }
```

  `gapMessage` names the unsatisfied requirements and the pending task refs that cover
  them and tells the model to continue and verify. When the boundary already carries
  `continue: true`, do not force again (loop guard) — just keep the tasks pending.
- `[SPEC]` gap + `Gate:` remain in the next `before_agent_start`, so the reminder is
  never lost even if the forced continuation is used up.

### 5.5 `plan_manager` (tool)

New actions (registered in `src/index.ts`):

- `plan` — bulk decomposition. `task_text` is one task per line; leading `[R1,R2]` or
  `R1:` is parsed as `reqs`. `lane` param applies to all (default `active`). Attaches
  `spec` from the referenced requirement's text. Returns the new refs.
- `coverage` — returns the `CoverageReport` plus the unsatisfied requirements with their
  covering task refs.
- `source` — `task_text` is a relative path; reads and ingests it (explicit opt-in: the
  `isSpecDocument` gate is bypassed, but the normative filter and caps still apply).
- `forget` — `task_text` (or `task_id`) is a source id (`S1`) or the source's path, or `all`.
  Removes the source, its requirements and any task whose `reqs` only covered them (tasks
  shared with another source keep the remaining ids). `promoteBacklog()` refills the lane.
  The hash is remembered so the same document cannot be re-ingested by accident (F-5).
- `verify` — `task_id` + `notes` (evidence). Sets `verifiedAt`, `verifyNote`, touches the
  task, re-runs `promoteBacklog()`. Returns the verification record.

New params: `lane` (`active|backlog|paused`), `reqs` (comma list), `check`
(`|`-separated acceptance steps). `add`/`update` accept all three; `update` also accepts
empty strings to clear (documented, not enforced).

`list` output appends ` [backlog]`/` [paused]` after the task text for those lanes.

### 5.6 Config

- `toggle()` handles `specMemory`, `specIngestFiles` and `specReviewGate`.
- `configItems()` adds three on/off rows (`🧠 Spec memory`, `📥 Ingest referenced specs`,
  `🛡️ Spec review gate`) with descriptions. The legacy select fallback gets the same lines.
- Turning `specMemory` off never deletes `specs`/`requirements`/lane data (read-only
  behaviour resumes).

## 6. Backward compatibility (must hold)

- All new fields are optional; a plan file without Specs/Requirements/lane markers parses
  exactly as before.
- Non-spec tasks (no `spec`, no `check`) complete without verification.
- Existing injected-context strings asserted by `tests/qa-footprint.test.mjs` must remain
  present (verbatim): `[PLAN]`, file name, `never git add/commit/publish`, `plan_*.md`,
  `Refs (#n) are stable`, a `Rules:` line containing `plan_manager`, `"2,3"` and `text`.
- `npm test` must stay green (all pre-existing suites).

## 7. Tests required

- `tests/spec-memory-utils.test.mjs` — `src/spec.ts`: detection thresholds, extraction
  (anchors, dedupe, caps), coverage (mapped/satisfied/percent), verification helpers.
- `tests/spec-serialization.test.mjs` — `generatePlanMarkdown`/`parsePlanSpecs`/
  `extractPlanTasks` round-trip: lane/reqs markers, spec/check/verified continuation,
  Specs/Requirements sections are not tasks.
- `tests/spec-memory-runtime.test.mjs` — harness integration: a structured prompt seeds
  backlog+active tasks, `[SPEC]` block appears, `complete` is refused until `verify`,
  premature conclusion forces `continue: true`, backlog promotes, plan file persists and
  re-adopts specs/requirements across sessions.
