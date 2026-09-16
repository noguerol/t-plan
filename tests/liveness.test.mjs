/**
 * Liveness contract of t-plan (plan tasks #5–#7):
 *
 *  (1) formatTaskForWidget: an in_progress task only animates (spinner +
 *      ⏱ elapsed timer) when {live:true}; with {live:false} it renders as a
 *      stopped line: starts with ⏸, no SPINNER_FRAMES, no ⏱ / timer.
 *  (2) Runtime idle: after agent_settled the task stays in_progress (kept by
 *      the active cue in the turn text) but the widget shows it stopped
 *      (⏸, no spinner, no timer) and the header has no "active" count.
 *  (3) Runtime live: mid-run the widget animates (spinner + ⏱) and the
 *      header shows "1 active".
 *  (4) Stale plan file: a brand-new session adopts a plan_*.md that contains
 *      an in_progress task from days ago; it must be parked to pending
 *      (no timer) and the rewritten file must not say "In Progress".
 *
 * NOTE: only `node --check` is guaranteed here — the orchestrator may be
 * editing src/runtime.ts concurrently, so do NOT run `npm test` from this
 * file's context.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const u = await import("../src/utils.ts");
const { SPINNER_FRAMES } = await import("../src/types.ts");

/** Theme that strips no characters: identity functions, so the raw glyphs are visible. */
const fakeCtx = {
  ui: {
    theme: {
      bold: (s) => s,
      fg: (_c, s) => s,
      bg: (_c, s) => s,
      strikethrough: (s) => s,
    },
  },
};

const NOW = 1_700_000_000_000;

const inProgressTask = {
  id: "t-1",
  ref: 1,
  text: "Tarea en curso",
  status: "in_progress",
  order: 1,
  startedAt: NOW - 30_000,
};

const hasSpinner = (line) => SPINNER_FRAMES.some((f) => line.includes(f));

// ── (1) formatTaskForWidget: stopped vs live rendering ────────────────────────
test("formatTaskForWidget: in_progress con live:false se pinta parada (⏸, sin spinner ni timer)", async () => {
  const line = u.formatTaskForWidget(fakeCtx, inProgressTask, { live: false, now: NOW });
  assert.ok(line.startsWith("⏸"), `debe empezar por ⏸: "${line}"`);
  assert.equal(hasSpinner(line), false, `sin frames de spinner: "${line}"`);
  assert.ok(!line.includes("⏱"), `sin timer ⏱: "${line}"`);
  assert.ok(!/\d{2}:\d{2}:\d{2}/.test(line), `sin tiempo transcurrido: "${line}"`);
});

test("formatTaskForWidget: in_progress con live:true anima (spinner + ⏱ cuando hay startedAt)", async () => {
  const line = u.formatTaskForWidget(fakeCtx, inProgressTask, { live: true, now: NOW });
  assert.ok(hasSpinner(line), `debe contener un frame de spinner: "${line}"`);
  assert.ok(line.includes("⏱ "), `debe contener el timer "⏱ ": "${line}"`);
  assert.ok(!line.startsWith("⏸"), `no debe marcarse como parada: "${line}"`);
});

// ── (2) Runtime idle: cue mantiene in_progress, widget la pinta parada ────────
test("runtime idle: el cue conserva in_progress pero el widget la muestra parada (⏸, sin spinner, header sin 'active')", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Revisar la arquitectura del módulo de pagos"]);
    await h.tool({ action: "start", task_id: "1" });
    await h.runStart();
    await h.turnEnd("Continúo con la revisión del módulo de pagos.", "stop");
    await h.settle();

    assert.equal((await h.statusByRef())[1], "in_progress", "el cue del resumen debe mantenerla activa");

    const widget = h.widgets.get("t-plan-tasks").join("\n");
    const header = h.widgets.get("t-plan-tasks")[0];
    assert.ok(widget.includes("⏸"), `la tarea inactiva debe pintarse con ⏸: ${JSON.stringify(widget)}`);
    assert.equal(hasSpinner(widget), false, `sin frames de spinner en el widget: ${JSON.stringify(widget)}`);
    assert.ok(!widget.includes("⏱"), `sin timer ⏱ en el widget: ${JSON.stringify(widget)}`);
    assert.ok(!header.includes("active"), `el header no debe contar activas: ${JSON.stringify(header)}`);
  } finally {
    await h.cleanup();
  }
});

// ── (3) Runtime live: mid-run el widget anima y el header cuenta activas ──────
test("runtime live: con run activo el widget anima (spinner + ⏱) y el header muestra '1 active'", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Tarea X"]);
    await h.runStart();
    await h.tool({ action: "start", task_id: "1" });

    const lines = h.widgets.get("t-plan-tasks");
    assert.ok(lines, "el widget debe estar pintado");
    const widget = lines.join("\n");
    const header = lines[0];
    assert.ok(hasSpinner(widget), `debe contener un frame de spinner: ${JSON.stringify(widget)}`);
    assert.ok(widget.includes("⏱"), `debe contener el timer ⏱: ${JSON.stringify(widget)}`);
    assert.ok(header.includes("1 active"), `el header debe decir '1 active': ${JSON.stringify(header)}`);
  } finally {
    await h.cleanup();
  }
});

// ── (4) Plan file obsoleto: in_progress heredado se parquea a pending ──────────
test("plan file obsoleto: una sesión nueva parquea el in_progress heredado a pending y reescribe sin 'In Progress'", async () => {
  const root = await mkdtemp(join(tmpdir(), "tplan-stale-"));
  const cwd = join(root, "staleapp");
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "plan_staleapp.md"),
    [
      "# staleapp Plan",
      "",
      "## Status: 0/1 completed",
      "",
      "- 🔄 In progress: 1",
      "",
      "## 🔄 In Progress",
      "",
      "- [ ] #1. Tarea vieja que nadie ejecuta",
      "",
    ].join("\n"),
    "utf-8"
  );

  const h = await createHarness({ cwd });
  try {
    assert.equal((await h.statusByRef())[1], "pending", "el in_progress heredado debe parquearse a pending");

    const widget = h.widgets.get("t-plan-tasks").join("\n");
    assert.equal(hasSpinner(widget), false, `sin frames de spinner: ${JSON.stringify(widget)}`);
    assert.ok(widget.includes("⏳") || widget.includes("⏸"), `debe pintarse como pendiente/parada: ${JSON.stringify(widget)}`);

    const md = await readFile(join(cwd, "plan_staleapp.md"), "utf-8");
    assert.doesNotMatch(md, /In Progress/, "el fichero reescrito no debe seguir diciendo 'In Progress'");
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
