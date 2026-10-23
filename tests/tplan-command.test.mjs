import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const lastNote = (h) => h.notes[h.notes.length - 1]?.msg ?? "";

// ── `/tplan <texto>` es el atajo de alta: sin subcomando ni diálogo ────────────
test("/tplan <text> adds the task and shows the pending list right away", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler("Comprar leche", h.ctx);

    const plan = await h.plan();
    assert.equal(plan.length, 1);
    assert.equal(plan[0].text, "Comprar leche");
    assert.equal(plan[0].status, "pending");
    assert.equal(h.inputCalls.length, 0, "no input dialog may open");

    const note = lastNote(h);
    assert.ok(note.includes("Comprar leche"), `pending list must include the task: ${note}`);
    assert.ok(note.includes("1 task pending"), `pending list must carry a header: ${note}`);

    assert.ok((await h.planFile()).includes("Comprar leche"), "the task is persisted to the plan file");
  } finally {
    await h.cleanup();
  }
});

test("/tplan <text> keeps the whole line, spaces included", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler("  Revisar   el endpoint /login  ", h.ctx);
    const plan = await h.plan();
    assert.equal(plan[0].text, "Revisar   el endpoint /login");
  } finally {
    await h.cleanup();
  }
});

test("/tplan add <text> escapes subcommand names", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler("add new", h.ctx);
    const plan = await h.plan();
    assert.equal(plan.length, 1);
    assert.equal(plan[0].text, "new", "'new' must be stored as a task, not run as a subcommand");
    assert.equal(h.inputCalls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("/tplan add with no text asks for nothing and adds nothing", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler("add", h.ctx);
    assert.equal((await h.plan()).length, 0);
    assert.equal(h.inputCalls.length, 0);
    assert.ok(lastNote(h).includes("usage"), `expected a usage hint, got: ${lastNote(h)}`);
  } finally {
    await h.cleanup();
  }
});

// ── la lista que se muestra es la de pendientes, no todo el plan ───────────────
test("the list shown after adding omits tasks that are already done", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Vieja", "Viva"]);
    await h.tool({ action: "start", task_id: "1" });
    await h.tool({ action: "complete", task_id: "1" });

    await h.rt.tPlanCommand.handler("Nueva", h.ctx);
    const note = lastNote(h);
    assert.ok(note.includes("2 tasks pending"), `done task must not count as pending: ${note}`);
    assert.ok(!note.includes("Vieja"), `done task must not be listed: ${note}`);
    assert.ok(note.includes("Viva") && note.includes("Nueva"), note);
  } finally {
    await h.cleanup();
  }
});

// ── sin texto sigue siendo el toggle de siempre ───────────────────────────────
test("/tplan with no text still toggles tracking and adds nothing", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler(undefined, h.ctx);
    assert.ok(lastNote(h).includes("OFF"), `expected OFF, got: ${lastNote(h)}`);
    assert.equal((await h.plan()).length, 0);

    await h.rt.tPlanCommand.handler(undefined, h.ctx);
    assert.ok(lastNote(h).includes("ON"), `expected ON, got: ${lastNote(h)}`);
    assert.equal((await h.plan()).length, 0);
  } finally {
    await h.cleanup();
  }
});

test("subcommands are still exact-match, not swallowed by the free-text add", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Uno"]);
    await h.rt.tPlanCommand.handler("show", h.ctx);
    assert.equal((await h.plan()).length, 1, "show must not create a task");
    assert.ok(lastNote(h).includes("Uno"), `show must print the plan: ${lastNote(h)}`);

    await h.rt.tPlanCommand.handler("show me the logs", h.ctx);
    const plan = await h.plan();
    assert.equal(plan.length, 2, "a longer 'show …' line is a task");
    assert.equal(plan[1].text, "show me the logs");
  } finally {
    await h.cleanup();
  }
});

test("/tplan <text> while the plan is off is refused (and says how to enable it)", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler("off", h.ctx);
    await h.rt.tPlanCommand.handler("Comprar pan", h.ctx);
    assert.equal((await h.plan()).length, 0);
    assert.ok(lastNote(h).includes("/tplan"), `expected the enable hint, got: ${lastNote(h)}`);
  } finally {
    await h.cleanup();
  }
});
