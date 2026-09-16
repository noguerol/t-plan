// Adversarial QA for src/utils.ts: naming / sessions / refs / tiers.
// Owns ONLY this file. Every assertion was written from an observed failure first.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";

// Deterministic DST-gap coverage for the stamp tests. node --test isolates each
// test file in its own process, so mutating TZ here cannot leak to other files.
process.env.TZ = "America/New_York";

let u;

before(async () => {
  await ensurePeers();
  u = await import("../src/utils.ts");
});

const mkState = (overrides = {}) => ({
  enabled: true,
  tasks: [],
  title: "my app Plan",
  titleAuto: false,
  createdAt: 1,
  updatedAt: 1,
  autoDetect: true,
  showWidget: true,
  widgetPlacement: "aboveEditor",
  ...overrides,
});

const sessionLine = (id, first, last, title) =>
  `- \`${id}\` — first seen ${first}, last seen ${last}` + (title ? ` — "${title}"` : "");

const sessionsSection = (entries, sep = "\n") => ["## 🗂 Sessions", "", ...entries, ""].join(sep);

// ── (a) refs must stay unique even when the file repeats a `#N.` handle ─────────
test("(a) two tasks parsed from '#1. x' do not keep duplicate refs", () => {
  const md = "## ⏳ Pending\n\n- [ ] #1. first\n- [ ] #1. second\n";
  const tasks = u.extractPlanTasks(md);
  assert.equal(tasks.length, 2);
  const refs = tasks.map((t) => t.ref);
  assert.equal(new Set(refs).size, refs.length, `duplicate refs survived: ${JSON.stringify(refs)}`);
  assert.deepEqual([...refs].sort((a, b) => a - b), [1, 2]);

  // assignRefs directly: first occurrence wins, the rest get fresh handles.
  const manual = [
    { id: "a", ref: 1, text: "a", status: "pending", order: 1 },
    { id: "b", ref: 1, text: "b", status: "pending", order: 2 },
    { id: "c", ref: 1, text: "c", status: "pending", order: 3 },
  ];
  u.assignRefs(manual);
  assert.equal(new Set(manual.map((t) => t.ref)).size, 3);

  // Unique refs are stable: never renumbered, reused or collapsed.
  const keep = [
    { id: "x", ref: 5, text: "x", status: "pending", order: 1 },
    { id: "y", ref: 3, text: "y", status: "pending", order: 2 },
    { id: "z", ref: 0, text: "z", status: "pending", order: 3 },
  ];
  u.assignRefs(keep);
  assert.deepEqual(keep.map((t) => t.ref), [5, 3, 6]);
});

// ── (b) ref parsing must not steal numbers from prose ──────────────────────────
test("(b) refFromTaskText only reads the leading '#N. ' handle", () => {
  assert.equal(u.refFromTaskText("#123. real task"), 123);
  assert.equal(u.refFromTaskText("Fix #123 now"), undefined);
  assert.equal(u.refFromTaskText("#7 no dot"), undefined);
  assert.equal(u.refFromTaskText("#123.real"), undefined); // dot but no space
  assert.equal(u.refFromTaskText("#007. leading zeros"), 7);
  assert.equal(u.refFromTaskText("  #5. indented handle"), 5);
  assert.equal(u.refFromTaskText("closes #12, refs #99"), undefined);

  // End to end: a genuine handle is kept, prose is left as untagged text.
  const real = u.extractPlanTasks("## ⏳ Pending\n\n- [ ] #123. real task\n");
  assert.equal(real.length, 1);
  assert.equal(real[0].ref, 123);
  assert.equal(real[0].text, "real task");

  const prose = u.extractPlanTasks("## ⏳ Pending\n\n- [ ] Fix #123 now\n");
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text, "Fix #123 now");
  assert.equal(u.refFromTaskText(prose[0].text), undefined);
});

// ── (c) plan file naming: empty titles, metachars, CRLF, case, plan.md ─────────
test("(c) parsePlanFileName handles empty/symbol titles, metachars, CRLF and case", () => {
  // Titles that slugify to nothing are written as `untitled`, never `plan_.md`.
  assert.equal(u.planFileNameFor("plan", ""), "plan_untitled.md");
  assert.equal(u.planFileNameFor("plan", "!!! ### ***"), "plan_untitled.md");
  assert.deepEqual(u.parsePlanFileName("plan_untitled.md", "plan"), {
    titleSlug: "untitled",
    sessionId: undefined,
    legacy: false,
  });

  // `plan.md` is not a project plan file; an empty slug is not a match either.
  assert.equal(u.parsePlanFileName("plan.md", "plan"), null);
  assert.equal(u.parsePlanFileName("plan_.md", "plan"), null);
  assert.equal(u.parsePlanFileName("README.md", "plan"), null);

  // Regex metacharacters in the prefix are treated literally.
  assert.deepEqual(u.parsePlanFileName("p.lan_x.md", "p.lan"), {
    titleSlug: "x",
    sessionId: undefined,
    legacy: false,
  });
  assert.deepEqual(u.parsePlanFileName("a(b)c_y_01a048c3.md", "a(b)c"), {
    titleSlug: "y",
    sessionId: "01a048c3",
    legacy: true,
  });
  assert.deepEqual(u.parsePlanFileName("a+b_z_noid.md", "a+b"), {
    titleSlug: "z",
    sessionId: undefined,
    legacy: true,
  });

  // Case-insensitive match, original slug case preserved.
  assert.deepEqual(u.parsePlanFileName("PLAN_My-App.MD", "plan"), {
    titleSlug: "My-App",
    sessionId: undefined,
    legacy: false,
  });

  // CRLF-adjacent / padded names coming from a directory listing or CRLF read.
  assert.deepEqual(u.parsePlanFileName("plan_my-app.md\r", "plan"), {
    titleSlug: "my-app",
    sessionId: undefined,
    legacy: false,
  });
  assert.deepEqual(u.parsePlanFileName("plan_my-app.md\r\n", "plan"), {
    titleSlug: "my-app",
    sessionId: undefined,
    legacy: false,
  });
  assert.deepEqual(u.parsePlanFileName("  plan_my-app.md  ", "plan"), {
    titleSlug: "my-app",
    sessionId: undefined,
    legacy: false,
  });
});

// ── (d) Sessions parsing: CRLF, no trailing NL, malformed, quotes, dups, 25 ────
test("(d) parsePlanSessions is robust to line endings and malformed entries", () => {
  const first = "2026-01-01 00:00:00";
  const last = "2026-01-01 01:00:00";

  // CRLF file (Windows editor) must not drop the whole section.
  assert.deepEqual(
    u.parsePlanSessions(sessionsSection([sessionLine("aa", first, last)], "\r\n")).map((s) => s.id),
    ["aa"]
  );

  // Missing trailing newline.
  assert.deepEqual(
    u.parsePlanSessions(["## 🗂 Sessions", "", sessionLine("bb", first, last)].join("\n")).map((s) => s.id),
    ["bb"]
  );

  // Malformed lines are skipped; backticked id parsed; quoted title kept verbatim.
  const parsed = u.parsePlanSessions(
    ["## 🗂 Sessions", "", "- garbage", "- `x` — first seen nope, last seen nope", sessionLine("cc", first, last, 'He said "hi" — ok')].join("\n")
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "cc");
  assert.equal(parsed[0].title, 'He said "hi" — ok');
  assert.equal(parsed[0].startedAt, u.parseSessionStamp(first));
  assert.equal(parsed[0].lastSeenAt, u.parseSessionStamp(last));

  // Duplicate ids are returned verbatim; the runtime is responsible for merging.
  assert.deepEqual(
    u.parsePlanSessions(
      sessionsSection([
        sessionLine("same", first, last),
        sessionLine("same", "2026-01-01 02:00:00", "2026-01-01 03:00:00"),
      ])
    ).map((s) => s.id),
    ["same", "same"]
  );

  // 25 entries are all read (the 20 cap belongs to the writer, not the parser).
  const many = Array.from({ length: 25 }, (_, i) =>
    sessionLine(`s${String(i).padStart(5, "0")}`, `2026-01-01 00:00:${String(i).padStart(2, "0")}`, `2026-01-01 00:00:${String(i).padStart(2, "0")}`)
  );
  assert.equal(u.parsePlanSessions(sessionsSection(many)).length, 25);

  // An id containing a literal backtick would break the format: that line is skipped.
  assert.equal(u.parsePlanSessions(sessionsSection([sessionLine("a`b", first, last)])).length, 0);

  // The section closes at the next heading.
  const closed = u.parsePlanSessions(
    sessionsSection([sessionLine("dd", first, last)]) + "## Other\n\n" + sessionLine("ee", first, last)
  );
  assert.deepEqual(closed.map((s) => s.id), ["dd"]);
});

// ── (e) stamps: 0, negative, NaN, impossible dates and a DST-nonexistent time ──
test("(e) formatSessionStamp/parseSessionStamp survive edge and invalid inputs", () => {
  // Epoch and pre-epoch: finite, well-formed and round-tripping.
  for (const ts of [0, -1000]) {
    const stamp = u.formatSessionStamp(ts);
    assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(u.parseSessionStamp(stamp), ts);
  }

  // NaN / Infinity must not leak a "NaN-NaN-NaN ..." stamp into the plan file.
  assert.equal(u.formatSessionStamp(NaN), "");
  assert.equal(u.formatSessionStamp(Infinity), "");
  assert.ok(Number.isNaN(u.parseSessionStamp("")));
  assert.ok(Number.isNaN(u.parseSessionStamp(u.formatSessionStamp(NaN))));

  // Impossible calendar dates are unparseable rather than silently normalised.
  assert.ok(Number.isNaN(u.parseSessionStamp("2026-13-45 99:99:99")));
  assert.ok(Number.isNaN(u.parseSessionStamp("2026-02-30 10:00:00")));
  assert.ok(Number.isNaN(u.parseSessionStamp("garbage")));
  assert.ok(Number.isNaN(u.parseSessionStamp(undefined)));

  // DST-nonexistent local time. With TZ=America/New_York, 2026-03-08 02:30 does
  // not exist (clocks jump 02:00 → 03:00); it must still parse to a finite,
  // idempotent value rather than NaN.
  const gap = new Date(2026, 2, 8, 2, 30, 0);
  const ts = u.parseSessionStamp("2026-03-08 02:30:00");
  assert.ok(Number.isFinite(ts), "nonexistent local time must not be rejected");
  assert.equal(u.parseSessionStamp(u.formatSessionStamp(ts)), ts, "stamp round-trip must be idempotent");
  if (gap.getHours() === 3) {
    assert.equal(u.formatSessionStamp(ts), "2026-03-08 03:30:00", "gap time normalises forward");
  }
});

// ── (f) the Sessions section must never be parsed as tasks ─────────────────────
test("(f) the Sessions section never leaks into tasks", () => {
  const state = mkState({
    tasks: [
      { id: "a", ref: 1, text: "real pending", status: "pending", order: 1 },
      { id: "b", ref: 2, text: "real done", status: "done", order: 2 },
    ],
    sessions: [
      { id: "sessX001", startedAt: 1000, lastSeenAt: 2000, title: "1. looks like a task" },
      { id: "sessY002", startedAt: 3000, lastSeenAt: 4000 },
    ],
  });
  const md = u.generatePlanMarkdown(state, { trimegisto: true });
  assert.deepEqual(u.extractPlanTasks(md).map((t) => t.text).sort(), ["real done", "real pending"]);
  assert.equal(u.parsePlanSessions(md).length, 2);

  // A hand-authored h3 Sessions heading must also close the plan section.
  const h3 =
    '## ⏳ Pending\n\n- [ ] #1. real\n\n### Sessions\n\n' +
    '- `dead` — first seen 2026-01-01 00:00:00, last seen 2026-01-01 01:00:00 — "1. fake"\n';
  assert.deepEqual(u.extractPlanTasks(h3).map((t) => t.text), ["real"]);

  // Sessions-only content yields nothing.
  assert.deepEqual(
    u.extractPlanTasks(sessionsSection([sessionLine("dead", "2026-01-01 00:00:00", "2026-01-01 01:00:00")])),
    []
  );

  // CRLF headings are recognised (no silent loss of the whole plan).
  assert.equal(u.hasRealPlanStructure("## Plan\r\n"), true);
  assert.equal(u.extractPlanTasks("## ⏳ Pending\r\n\r\n- [ ] #1. real task\r\n").length, 1);
});

// ── (g) generatePlanMarkdown: sessions undefined and equal lastSeenAt ties ─────
test("(g) generatePlanMarkdown copes without sessions and sorts ties stably", () => {
  // Absent / explicitly undefined sessions: no section, no throw.
  const absent = u.generatePlanMarkdown(mkState({ tasks: [] }), {});
  assert.doesNotMatch(absent, /Sessions/);
  const explicit = u.generatePlanMarkdown(mkState({ tasks: [], sessions: undefined }), {});
  assert.doesNotMatch(explicit, /Sessions/);
  assert.deepEqual(u.parsePlanSessions(absent), []);

  // Equal lastSeenAt: order is stable (insertion order), and deterministic.
  const sessions = [
    { id: "zz", startedAt: 1, lastSeenAt: 500 },
    { id: "aa", startedAt: 2, lastSeenAt: 500 },
    { id: "mm", startedAt: 3, lastSeenAt: 500 },
  ];
  const ids = (md) => u.parsePlanSessions(md).map((s) => s.id);
  const first = ids(u.generatePlanMarkdown(mkState({ sessions }), {}));
  assert.deepEqual(first, ["zz", "aa", "mm"]);
  const second = ids(u.generatePlanMarkdown(mkState({ sessions }), {}));
  assert.deepEqual(second, first, "generation is deterministic for tied timestamps");

  // The writer caps at the 20 most recent; ties past the cap stay deterministic.
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `tie${String(i).padStart(2, "0")}`, startedAt: i, lastSeenAt: 1000 }));
  assert.equal(u.parsePlanSessions(u.generatePlanMarkdown(mkState({ sessions: many }), {})).length, 20);
});

// ── Regresiones extra (rebase sobre los fixes anteriores) ──────────────────────
// `refFromTaskText` exige un espacio tras el punto, así que `cleanTaskText` NUNCA
// debe recortar un `#N.` pegado a texto: si lo hiciera, el rótulo real se perdería
// sin que nadie hubiese capturado el ref.
test("(b) '#N.' sin espacio no es un asa y el texto original sobrevive", () => {
  const [task] = u.extractPlanTasks("## ⏳ Pending\n\n- [ ] #123.real task\n");
  assert.equal(task.text, "#123.real task", "el rótulo pegado no debe recortarse");
  assert.notEqual(task.ref, 123);
  assert.equal(u.refFromTaskText("#123.real task"), undefined);
});

// La validación de sellos debe cubrir fecha Y hora; un minuto/segundo imposible
// se normalizaba en silencio a otro instante distinto.
test("(e) parseSessionStamp rechaza componentes de hora/minuto/segundo fuera de rango", () => {
  for (const bad of [
    "2026-09-14 10:99:00",
    "2026-09-14 10:00:99",
    "2026-09-14 99:00:00",
    "2026-09-45 10:00:00",
    "2026-00-10 10:00:00",
  ]) {
    assert.ok(Number.isNaN(u.parseSessionStamp(bad)), `debería ser NaN: ${bad}`);
  }
  // Un valor válido sigue parseándose.
  assert.equal(
    u.parseSessionStamp("2026-09-14 23:59:59"),
    new Date(2026, 8, 14, 23, 59, 59).getTime()
  );
});

// `containsPlan` corre sobre texto pegado por el modelo; con CRLF los regex `.+$`
// no casaban y un plan real podía no detectarse.
test("(c/f) containsPlan reconoce listas numeradas/checkbox con CRLF", () => {
  assert.equal(u.containsPlan("1. uno\r\n2. dos\r\n3. tres\r\n"), true);
  assert.equal(u.containsPlan("- [ ] uno\r\n- [x] dos\r\n- [ ] tres\r\n"), true);
  assert.equal(u.containsPlan("1. uno\r\n2. dos\r\n"), false, "dos elementos no llegan al umbral");
  assert.equal(u.containsPlan("## Plan\r\n"), true);
});

// `assignRefs` conserva los refs únicos y da asas nuevas por encima del mayor
// existente, sin reciclar ni colapsar los ya presentes.
test("(a) assignRefs con huecos y duplicados no recicla asas", () => {
  const tasks = [
    { id: "a", ref: 3, text: "a", status: "pending", order: 1 },
    { id: "b", ref: 3, text: "b", status: "pending", order: 2 },
    { id: "c", ref: 0, text: "c", status: "pending", order: 3 },
  ];
  u.assignRefs(tasks);
  assert.deepEqual(tasks.map((t) => t.ref), [3, 4, 5]);
  assert.equal(new Set(tasks.map((t) => t.ref)).size, 3);
});

// La sección de sesiones es metadato: incluso una línea con forma de checkbox
// (inyectada a mano o por un título multilínea) no debe importarse como tarea.
test("(f) un checkbox dentro de Sessions no se importa como tarea", () => {
  const md = [
    "# p Plan",
    "## ⏳ Pending",
    "- [ ] #1. real task",
    "## 🗂 Sessions",
    "- `sess` — first seen 2026-09-14 19:05:21, last seen 2026-09-14 19:05:22",
    "- [ ] #99. sneaky session checkbox",
    "- [x] #100. done sneaky",
    "",
  ].join("\n");
  const tasks = u.extractPlanTasks(md);
  assert.deepEqual(tasks.map((t) => t.text), ["real task"]);
  assert.deepEqual(tasks.map((t) => t.ref), [1]);
});

// ── Liveness en el widget: in_progress sólo se anima si alguien lo ejecuta ──────
// `formatTaskForWidget` distingue "marcada como in_progress" (intención) de
// "ejecutándose ahora" (`live`). Sin run/agente vivo debe leerse parada: ⏸,
// sin spinner, sin timer y en muted (nunca en acento).
const mkTheme = () => ({
  bold: (s) => s,
  fg: (_c, s) => s,
  bg: (_c, s) => s,
  strikethrough: (s) => s,
  accent: (s) => `ACCENT(${s})`,
});
const widgetCtx = { ui: { theme: mkTheme() } };
const SPINNERS = (await import("../src/types.ts")).SPINNER_FRAMES;
const hasSpinner = (line) => SPINNERS.some((f) => line.includes(f));

test("(live) in_progress con live:false se pinta parada (⏸, sin spinner ni timer)", () => {
  const task = { id: "a", ref: 1, text: "Tarea en curso", status: "in_progress", order: 1, startedAt: Date.now() - 5000 };
  const line = u.formatTaskForWidget(widgetCtx, task, { live: false, now: Date.now() });
  assert.match(line, /⏸/, `debe marcarse parada: ${line}`);
  assert.equal(hasSpinner(line), false, `no debe girar: ${line}`);
  assert.ok(!line.includes("⏱"), `no debe tener timer: ${line}`);
});

test("(live) in_progress con live:true gira y muestra timer", () => {
  const task = { id: "a", ref: 1, text: "Tarea en curso", status: "in_progress", order: 1, startedAt: Date.now() - 5000 };
  const line = u.formatTaskForWidget(widgetCtx, task, { live: true, now: Date.now() });
  assert.equal(hasSpinner(line), true, `debe girar: ${line}`);
  assert.match(line, /⏱ \d\d:\d\d:\d\d/, `debe tener timer: ${line}`);
});

test("(live) sin opción live se preserva el comportamiento clásico (gira)", () => {
  const task = { id: "a", ref: 1, text: "Tarea en curso", status: "in_progress", order: 1, startedAt: Date.now() - 5000 };
  const line = u.formatTaskForWidget(widgetCtx, task, { now: Date.now() });
  assert.equal(hasSpinner(line), true, `default = running: ${line}`);
});
