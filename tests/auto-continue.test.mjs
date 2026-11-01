import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const lastNote = (h) => h.notes[h.notes.length - 1]?.msg ?? "";
const refsOf = (h) => h.plan().then((p) => p.map((t) => t.ref));

// ── el agente no se para mientras queden tareas pendientes ─────────────────────
test("agent_before_settle forces the next pending task in plan order", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera tarea", "Segunda tarea"]);
    const context = await h.runStart();
    assert.match(
      context.message.content,
      /Queue: pending tasks are executed IN ORDER/,
      "the turn context must state the queue invariant"
    );

    const res = await h.beforeSettle("completed");
    assert.equal(res?.continue, true, "must request one continuation");
    const content = res.entries[0].content;
    assert.match(content, /#1\. Primera tarea/, "next task must be #1 (plan order)");
    assert.match(content, /plan_manager start task_id=1/);
    assert.match(content, /plan_manager complete task_id=1/);
    assert.match(content, /#2\. Segunda tarea/, "the whole queue must be visible");
    assert.ok(lastNote(h).includes("#1"), `expected a visible notice, got: ${lastNote(h)}`);
  } finally {
    await h.cleanup();
  }
});

test("a task added while the agent is working is picked up at the boundary", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Tarea en curso"]);
    await h.runStart();
    await h.tool({ action: "start", task_id: "1" });

    // The user types /tplan <texto> while the run is active.
    await h.rt.tPlanCommand.handler("Tarea añadida en caliente", h.ctx);

    const res = await h.beforeSettle("completed");
    assert.equal(res?.continue, true);
    assert.match(res.entries[0].content, /#1\. Tarea en curso/);
    assert.match(res.entries[0].content, /#2\. Tarea añadida en caliente/);
  } finally {
    await h.cleanup();
  }
});

test("a model conclusion neither drops nor finalizes a user-added pending task", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Tarea del modelo"]);
    await h.runStart();
    await h.tool({ action: "start", task_id: "1" });
    await h.rt.tPlanCommand.handler("Tarea del usuario", h.ctx);

    // "Todo listo" is a conclusion: model tasks are finalized, the user task is
    // the next unit of work and must survive as pending.
    await h.turnEnd("Ya está todo listo.", "stop");
    const plan = await h.plan();
    const user = plan.find((t) => t.text.includes("Tarea del usuario"));
    assert.ok(user, `user task must survive the conclusion: ${JSON.stringify(plan)}`);
    assert.equal(user.status, "pending", "only explicit completion/evidence closes a user task");

    // And the boundary then sends the agent to it.
    const res = await h.beforeSettle("completed");
    assert.equal(res?.continue, true);
    assert.match(res.entries[0].content, /#2\. Tarea del usuario/);
  } finally {
    await h.cleanup();
  }
});

test("a conclusion still finalizes untouched model tasks (ghost-task cleanup intact)", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Autenticación JWT en src/auth.ts", "Tarea fantasma que nadie toca"]);
    await h.runStart();
    await h.tool({ action: "start", task_id: "1" });
    await h.toolResult("edit", { path: "src/auth.ts" });
    await h.turnEnd("Ya está todo listo.", "stop");
    const plan = await h.plan();
    assert.equal(plan.length, 1, `the untouched model task is still dropped: ${JSON.stringify(plan)}`);
    assert.equal(plan[0].status, "done");
  } finally {
    await h.cleanup();
  }
});

// ── frenos: nunca por encima de una parada explícita ni en bucle ───────────────
test("auto-continue off leaves the plan parked", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Pendiente"]);
    h.rt.getConfig().autoContinue = false;
    assert.equal(await h.beforeSettle("completed"), undefined);
  } finally {
    await h.cleanup();
  }
});

test("with nothing pending there is no continuation", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Hecha"]);
    await h.tool({ action: "complete", task_id: "1" });
    assert.equal(await h.beforeSettle("completed"), undefined);
  } finally {
    await h.cleanup();
  }
});

test("backlog tasks are not auto-executed (they wait for promotion)", async () => {
  const h = await createHarness();
  try {
    await h.tool({ action: "add", task_text: "Tarea en backlog", lane: "backlog" });
    await h.tool({ action: "add", task_text: "Tarea activa" });
    const res = await h.beforeSettle("completed");
    assert.equal(res?.continue, true);
    const content = res.entries[0].content;
    assert.match(content, /#2\. Tarea activa/);
    assert.ok(!content.includes("Tarea en backlog"), `backlog must stay out: ${content}`);
  } finally {
    await h.cleanup();
  }
});

test("an aborted run never continues, but an errored one is retried", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Pendiente"]);
    assert.equal(await h.beforeSettle("aborted"), undefined, "Esc must win");
    assert.equal((await h.beforeSettle("error"))?.continue, true, "errors must not strand the queue");
  } finally {
    await h.cleanup();
  }
});

test("the emergency brake only fires after 5 continuations with no tool work", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Tarea atascada"]);
    for (let i = 0; i < 5; i++) {
      assert.equal((await h.beforeSettle("completed"))?.continue, true, `attempt ${i + 1} must continue`);
    }
    assert.equal(await h.beforeSettle("completed"), undefined, "6th idle attempt must stop");
    assert.ok(lastNote(h).includes("auto-continue paused"), `expected the brake notice, got: ${lastNote(h)}`);
  } finally {
    await h.cleanup();
  }
});

test("tool activity resets the brake: real work is never cut short", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Tarea larga"]);
    for (let i = 0; i < 4; i++) {
      assert.equal((await h.beforeSettle("completed"))?.continue, true);
    }
    await h.toolResult("edit", { path: "src/app.ts" });
    // Without the reset this would be the 6th idle continuation and would stop.
    assert.equal((await h.beforeSettle("completed"))?.continue, true);
    assert.equal((await h.beforeSettle("completed"))?.continue, true);
  } finally {
    await h.cleanup();
  }
});

test("turn_end enforces the queue as soon as the model stops with a text-only turn", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera", "Segunda"]);
    await h.runStart();
    const res = await h.turnEnd("Aquí estoy.", "stop");
    assert.equal(res?.continue, true, "a text-only turn with pending work must continue");
    assert.match(res.entries[0].content, /#1\. Primera/, "it must send the agent to the first pending task");
  } finally {
    await h.cleanup();
  }
});

test("turn_end does not interrupt a turn that ran tools", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera"]);
    await h.runStart();
    const res = await h.turnEnd("Voy a leer el fichero.", "stop", [{ toolName: "read", content: [], isError: false }]);
    assert.equal(res, undefined, "tool work must be left alone; pi already continues");
  } finally {
    await h.cleanup();
  }
});

test("agent_settled restarts the queue when the boundary could not continue", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Pendiente"]);
    await h.runStart();
    await h.settle(); // no turn_end / no before_settle in this path
    assert.ok(h.sendUserMessageCalls.length >= 1, "the fallback must start a run");
    assert.match(h.sendUserMessageCalls[0], /#1\. Pendiente/);
  } finally {
    await h.cleanup();
  }
});

test("the settle fallback restart preserves the emergency brake", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Tarea atascada"]);
    // Four idle boundary continuations: the brake is at 3.
    for (let i = 0; i < 4; i++) {
      assert.equal((await h.beforeSettle("completed"))?.continue, true);
    }
    await h.settle(); // fallback relaunches the queue
    await h.runStart(); // its before_agent_start must NOT reset the brake
    assert.equal((await h.beforeSettle("completed"))?.continue, true, "one more attempt before the cap");
    assert.equal(await h.beforeSettle("completed"), undefined, "the preserved brake still fires");
  } finally {
    await h.cleanup();
  }
});

test("agent_settled does not restart after an explicit abort nor after the brake", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Pendiente"]);
    await h.runStart();
    await h.turnEnd("Voy a ello.", "aborted"); // sets lastStopReason = aborted
    await h.settle();
    assert.equal(h.sendUserMessageCalls.length, 0, "Esc must never restart the run");

    // `agent_settled.aborted` alone (no assistant turn) is also a user stop.
    const h3 = await createHarness();
    try {
      await h3.addTasks(["Pendiente"]);
      await h3.runStart();
      await h3.settle(true);
      assert.equal(h3.sendUserMessageCalls.length, 0, "settled.aborted must never restart the run");
    } finally {
      await h3.cleanup();
    }

    // Reach the emergency brake through the boundary, then settle: no restart.
    const h2 = await createHarness();
    try {
      await h2.addTasks(["Atascada"]);
      for (let i = 0; i < 6; i++) await h2.beforeSettle("completed");
      await h2.settle();
      assert.equal(h2.sendUserMessageCalls.length, 0, "a stalled queue must not be restarted blindly");
    } finally {
      await h2.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test("completing a task resets the brake and moves to the next one", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera", "Segunda"]);
    assert.match((await h.beforeSettle("completed")).entries[0].content, /#1\. Primera/);
    await h.tool({ action: "start", task_id: "1" });
    await h.tool({ action: "complete", task_id: "1" });

    const res = await h.beforeSettle("completed");
    assert.equal(res?.continue, true);
    assert.match(res.entries[0].content, /#2\. Segunda/);
    assert.deepEqual(await refsOf(h), [1, 2], "refs stay stable");
  } finally {
    await h.cleanup();
  }
});

// ── las tareas del usuario no se borran por reconcile ni por prosa ─────────────
test("plan reconciliation keeps a user task the model leaves out", async () => {
  const { reconcilePlanTasks } = await import("../src/utils.ts");
  const current = [
    { id: "u1", ref: 1, text: "Tarea del usuario", status: "pending", order: 1, userAdded: true },
    { id: "m1", ref: 2, text: "Tarea del modelo", status: "pending", order: 2 },
  ];
  const incoming = [{ id: "n1", ref: 1, text: "Tarea nueva", status: "pending", order: 1 }];
  const res = reconcilePlanTasks(current, incoming, { removeMissing: true });
  assert.ok(res.tasks.some((t) => t.id === "u1"), "the user task must survive the reconcile");
  assert.ok(!res.tasks.some((t) => t.id === "m1"), "the missing model task is still dropped");
});

test("a model removing a user task by prose is ignored", async () => {
  const { detectRemovedTasks } = await import("../src/utils.ts");
  const tasks = [
    { id: "u1", ref: 1, text: "Revisar el pull request", status: "pending", order: 1, userAdded: true },
    { id: "m1", ref: 2, text: "Actualizar el README", status: "pending", order: 2 },
  ];
  assert.deepEqual(detectRemovedTasks("La tarea de revisar el pull request ya no hace falta.", tasks), []);
  assert.deepEqual(detectRemovedTasks("La tarea de actualizar el README ya no hace falta.", tasks), ["m1"]);
});

test("a user task survives the removal pass in a real turn_end", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler("Revisar el pull request", h.ctx);
    await h.runStart();
    await h.turnEnd("La tarea de revisar el pull request ya no hace falta, la descarto.", "stop");
    const plan = await h.plan();
    assert.ok(plan.some((t) => t.text.includes("Revisar el pull request")), JSON.stringify(plan));
  } finally {
    await h.cleanup();
  }
});

// ── persistencia del origen ────────────────────────────────────────────────────
test("userAdded round-trips through the plan file", async () => {
  const h = await createHarness();
  try {
    await h.rt.tPlanCommand.handler("Tarea manual persistente", h.ctx);
    const file = await h.planFile();
    assert.match(file, /^\s{2,}[-*]\s+user:\s*true$/m, `plan file must mark user tasks:\n${file}`);

    const { extractPlanTasks } = await import("../src/utils.ts");
    const parsed = extractPlanTasks(file, { minLength: 1 });
    assert.equal(parsed[0].userAdded, true);
  } finally {
    await h.cleanup();
  }
});
