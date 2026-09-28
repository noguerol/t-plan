# FIX — the auto-planner fills the plan with garbage harvested from notes

**Component:** `pi-t-plan` (auto-planner)
**Version examined:** 1.7.0 (`src/spec.ts`, `src/runtime.ts`; 5668 LOC across `src/`)
**Severity:** high — the plan claims to be the project memory, but its "requirements" and
"tasks" are note fragments and file paths, which poisons every coverage gate and buries the
real backlog.

---

## 1. Symptom

A plan file reached **232 requirements** (a coverage gate reporting `152/232 mapped, 31%`)
and **~90 pending tasks**, none of which were real work. Examples taken verbatim from the
generated plan:

```
R73.  id: 01a0c64a-46c
R80.  This file is private — it must never be committed to git or shared publicly.
R142. packages/core/src/run-service.ts
R151. packages/web/src/NewNodeDialog.tsx
#138. Why: Continuando con "cablear las vistas por kind", encontré y arreglé un bug …
#141. 281 tests, 14/14 build+typecheck, guards OK.
```

Every one of those came from a documentation file — project memory (`pi.md`), a
continuation brief, and an audit findings file — that the planner had ingested as if it were
a specification. Each **bullet** became a requirement, and each requirement became a **task**
carrying the bullet text as its `spec`.

Hand-rewriting the plan does not stick: the next tool call regenerates it from the state the
planner derived, so the junk returns with new ids.

## 2. Reproduction

```bash
cd /path/to/t-plan
node --experimental-strip-types probe.mjs
```

```js
// probe.mjs
const { looksLikeComplexSpec, extractRequirements } =
  await import('/path/to/t-plan/src/spec.ts');
const { readFileSync } = await import('node:fs');

for (const f of [
  '/path/to/project/pi.md',
  '/path/to/project/docs/CONTINUATION.md',
  '/path/to/project/docs/testing/audit/findings.md',
]) {
  const text = readFileSync(f, 'utf8');
  const reqs = extractRequirements(text, 'probe');
  console.log(
    f.split('/').pop().padEnd(22),
    'gate=', String(looksLikeComplexSpec(text)).padEnd(5),
    'requirements=', String(reqs.length).padStart(3),
    'first="' + (reqs[0]?.text ?? '').slice(0, 52) + '"',
  );
}
```

**Observed output**

```
pi.md                  gate=true  requirements= 80  first="id: 01a0c64a-46c"
CONTINUATION.md        gate=true  requirements= 41  first="Purpose: everything a new session needs to pick this"
findings.md            gate=true  requirements= 40  first="Method: pen frame → implementation check, plus rever"
```

Two conclusions, both important:

1. Documentation files **are** being converted into requirements — 80 of them from `pi.md`
   alone (that is the cap; the file has far more bullets).
2. The existing guard, `looksLikeComplexSpec()`, returns **`true`** for all three. Applying
   it to file ingestion and stopping there would **not** fix this.

## 3. Root causes (with locations)

### RC-1 — referenced markdown is ingested as a spec, with no gate at all

`src/runtime.ts`, `ingestReferencedFiles()` (~line 2139):

```ts
async function ingestReferencedFiles(prompt: string, ctx: ExtensionContext): Promise<number> {
  if (!config.specMemory || !prompt) return 0;
  const matches = prompt.match(/[\w./-]+\.(?:md|markdown|txt)\b/gi) ?? [];
  …
  added += ingestSpec(await readFile(abs, 'utf-8'), "file", rel);
```

Any `.md`/`.markdown`/`.txt` path **mentioned in the prompt** is read and handed to
`ingestSpec()`. Compare with the prompt path in the same file (~line 2315), which *is* gated:

```ts
if (looksLikeComplexSpec(prompt)) seeded += ingestSpec(prompt, "prompt", "prompt");
```

So an ordinary sentence like *"see `docs/CONTINUATION.md`"* turns that document into a
requirement source. This is the direct cause of R80/R142/R151: they are lines of `pi.md` and
of a brief that was referenced in conversation.

### RC-2 — every bullet becomes a requirement

`src/spec.ts`, `extractRequirements()` (~line 116):

```ts
const bullet = line.match(BULLET_RE) ?? line.match(NUMBERED_RE);
if (bullet) {
  sectionHasList = true;
  push(bullet[1], anchor);          // ← one requirement per bullet
  continue;
}
```

`push()` only rejects via `acceptable()` and a signature dedupe. There is no notion of the
bullet being *normative*. A "Files touched" list, a changelog, a table of contents, or a
checklist in a prompt all become requirements. `MAX_REQUIREMENTS = 80` caps a single call,
which is why `pi.md` yields exactly 80.

### RC-3 — `looksLikeComplexSpec()` is too permissive to be the gate

`src/spec.ts` (~line 33):

```ts
const structural = lines.filter(
  (l) => /^\s*(?:#{1,6}\s+\S|[-*+]\s+\S|\d+[.)]\s+\S)/.test(l)
).length;
if (lines.length >= 8 && structural >= 6) return true;
```

Any document with 8+ non-empty lines and 6+ bullets or headings passes. Project memory, a
brief, a findings log and a changelog all satisfy that. Proven by §2: `gate=true` for every
documentation file tested.

There is also a weaker trap: `SPEC_KEYWORDS` includes `MUST|SHALL|DEBE`, and prose about a
product ("you must be able to…") trips it.

### RC-4 — requirements become tasks, so junk is *executable* noise

`src/runtime.ts`, `ingestSpec()` (~line 2109):

```ts
for (let i = 0; i < raws.length; i++) {
  const raw = raws[i];
  const id = nextRequirementId(reqs);
  reqs.push({ id, sourceId: raw.sourceId, … text: raw.text });
  const lane: TaskLane = i < SPEC_ACTIVE_WINDOW ? "active" : "backlog";
  addTask(raw.text, "pending", undefined, undefined, { lane, reqs: [id], spec: raw.text, … });
```

Each requirement seeds a task whose title is the raw bullet. So a file path becomes a task
named after the file. `SPEC_ACTIVE_WINDOW = 5` pushes everything past the fifth item to
`backlog`, which is why the backlog is the worst-affected section.

### RC-5 — no budget on sources, and no way to retract one

`MAX_REQUIREMENTS` is per call, not per project. Nothing prunes `state.specs` or
`state.requirements`, and there is no "forget this source" action. Once a document has been
ingested, its 80 requirements are permanent, and re-ingesting a changed file adds more
(the `hash` guard only prevents the *identical* text).

## 4. Required fixes

### F-1 · Gate file ingestion, and default to refusing (RC-1)

In `ingestReferencedFiles`, require an explicit signal before ingesting:

```ts
if (!looksLikeComplexSpec(text)) continue;              // necessary but not sufficient
if (!isSpecDocument(rel, text)) continue;               // see F-2
```

Raise the bar further: ingestion of referenced files should be **opt-in** (a config flag
defaulting to off), because the cost of a false positive is a permanently polluted plan while
the cost of a false negative is one explicit `source` action by the user.

### F-2 · Add a real `isSpecDocument()` predicate (RC-3)

`looksLikeComplexSpec` answers "is this structured enough to decompose?", not "is this a
specification?". Add a separate predicate and require both:

- **Path denylist:** `pi.md`, `plan_*.md`, `**/node_modules/**`, `.pi/**`, `CHANGELOG*`,
  `CONTRIBUTING*`, `LICENSE*`, anything under `docs/adr/`, anything under `docs/testing/`.
- **Path allowlist (preferred):** only ingest when the text or the file *declares itself* a
  spec — e.g. the filename matches `spec`, `requirements`, `prd`, or the document contains
  requirement identifiers (`RF-\d+`, `RNF-\d+`, `REQ-\d+`, `P0-REQ-`, `P1-REQ-`, `T-…`) or
  an explicit `## Requirements` / `## Acceptance criteria` heading.
- **Normative-bullet check:** require the bullet to look normative (see F-3) before counting
  it.

Strengthen the structural heuristic too: raise the bar and require *normative* structure, not
any structure. `lines >= 8 && structural >= 6` should become something that cannot be
satisfied by a notes file — e.g. require a requirements heading **and** at least one modal
verb, or at least N identifiers.

### F-3 · Only normative bullets are requirements (RC-2)

In `extractRequirements`, keep bullets only when they read as obligations:

- The bullet contains a modal/action verb (`MODAL_VERB`/`ACTION_VERB`, already defined) **or**
  an identifier (`RF-`, `REQ-`, `P0-REQ-`, …), **or**
- the bullet's `anchor` heading is one of a small allowlist (`Requirements`,
  `Acceptance criteria`, `Scope`, `Deliverables`, …).

This alone removes every observed junk case: `packages/web/src/App.tsx`,
`id: 01a0c64a-46c` and `281 tests, 14/14 build` are not obligations.

Also skip bullets that match obvious non-normative patterns: a bare path, a bare UUID, a
`key: value` line, a metric line (`\d+ tests?`, `\d+/\d+`).

### F-4 · Separate "task" from "requirement" (RC-4)

Do not create a task per requirement automatically. Either:

- keep requirements as a coverage ledger only, and create tasks only for requirements that are
  `active` in the current spec window, or
- require an explicit promote step (there is already a `promoteBacklog()`; make promotion the
  only path from requirement → task).

At minimum, never set a task's **title** to a raw requirement line: derive a short title (first
clause, truncated) and keep the full text in `spec`.

### F-5 · Make sources retractable and bounded (RC-5)

- Add a `forget` action: remove a `SpecSource` and its requirements and any task whose only
  `reqs` entry was that requirement.
- Cap the total: e.g. the newest `K` sources are authoritative; older sources' requirements
  move out of the coverage denominator (the gate should count only *active* sources, not the
  whole history).
- Record `sourceId` on every task (already present) and refuse to keep tasks whose source was
  removed.

### F-6 · Never measure coverage over a polluted denominator

Whatever the fix, the coverage gate must be able to say "these requirements do not come from a
spec". Today a single ingested `pi.md` adds 80 to the denominator and drops the reported
percentage, which is how a project with 8 real tasks reported `31%`.

### F-7 · Stop regenerating away manual edits

The plan file is regenerated from internal state, so hand edits are lost. Either
(a) support a reserved, tool-owned block plus a verbatim user block (same design as the
`pi.md` fix in `punched-memory/docs/FIX-pi-md-manual-contributions.md`), or
(b) stop presenting the file as hand-editable and emit a prominent header saying edits are
overwritten. Silently discarding a user's plan edits is the worst option.

## 5. Tests to add

1. **Bad-source rejection** — feed `extractRequirements` a fixture resembling project memory
   (a session log with `#### Files touched` and path bullets) and assert **0** requirements.
2. **Referenced-file gate** — a prompt that merely mentions `docs/CONTINUATION.md` must not
   create any spec source.
3. **Normative bullets only** — a list of paths/UUIDs/metrics yields 0; a list of `MUST …`
   lines yields one requirement each.
4. **Source budget** — ingesting a large real document cannot add more than the configured
   per-source cap, and the total count stays within the project cap.
5. **Retraction** — `forget` removes the source, its requirements, and its tasks; coverage
   recomputes without them.
6. **Idempotence** — re-ingesting the same file adds nothing; ingesting a *changed* file does
   not resurrect previously removed requirements.
7. **Manual-edit survival** — a user-owned block in the plan file survives a regenerate
   (only if F-7(a) is chosen).

## 6. Acceptance criteria

- [ ] A prompt that references a documentation file creates **no** requirement source.
- [ ] `extractRequirements` returns 0 for `pi.md`, a continuation brief, an ADR, a changelog
      and a findings log (all return 80/41/40/… today).
- [ ] A requirement whose text is a file path, a UUID, or a metric line is never created.
- [ ] Tasks are no longer auto-created one-per-requirement; promotion is explicit or limited
      to the active window.
- [ ] A source can be retracted, and retracting it removes its requirements and tasks.
- [ ] `npm test` and `npm run verify` pass with the new cases.

## 7. Notes

- The prompt path is *already* correctly gated (`looksLikeComplexSpec`) — the asymmetry with
  the file path is the bug, and it is a two-line fix at minimum.
- `MAX_REQUIREMENTS = 80` made this worse rather than better: it guaranteed that a big
  document contributed exactly 80 requirements, i.e. just enough to move the coverage figure
  without any of them being real.
- A cheap immediate mitigation, independent of the rest: **snapshot the plan before each
  regenerate** so a polluted state is recoverable, and log which `sourceId` contributed each
  requirement (that data already exists and would have made this diagnosable in seconds).
