import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const TASKS = [
  "Añadir autenticación JWT en src/auth.ts",
  "Escribir tests del endpoint /login",
  "Actualizar README con la nueva API",
];

// ── Causa raíz #1: agent_settled degradaba in_progress → pending en CADA run ────
test("agent_settled con stop normal NO devuelve a pendiente una tarea en curso", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Revisar la arquitectura del módulo de pagos"]);
    await h.tool({ action: "start", task_id: "1" });
    await h.runStart();
    await h.turnEnd("Continúo con la revisión del módulo de pagos.", "stop");
    await h.settle();
    assert.equal((await h.statusByRef())[1], "in_progress");
  } finally {
    await h.cleanup();
  }
});

test("agent_settled tras un run interrumpido sí pausa lo que estaba en curso", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Revisar la arquitectura del módulo de pagos"]);
    await h.tool({ action: "start", task_id: "1" });
    await h.runStart();
    await h.turnEnd("Revisando el módulo de pagos.", "aborted");
    await h.settle();
    assert.equal((await h.statusByRef())[1], "pending");
    assert.ok(h.notes.some((n) => n.msg.includes("paused")), "debe avisar de la pausa");
  } finally {
    await h.cleanup();
  }
});

// ── Causa raíz #3: la evidencia de herramientas completa tareas reales ───────────
test("run completo: la evidencia de ficheros tocados completa las 3 tareas al cerrar", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    await h.runStart();
    await h.toolResult("edit", { path: "src/auth.ts" });
    await h.toolResult("write", { path: "tests/login.test.ts" });
    await h.toolResult("bash", { command: "npx vitest run tests/login.test.ts" });
    await h.toolResult("edit", { path: "README.md" });
    // Resumen sin marcadores [DONE:] y sin llamada a plan_manager:
    await h.turnEnd("Listo. Cambios aplicados en los ficheros del proyecto.", "stop");
    await h.settle();
    assert.deepEqual(await h.statusByRef(), { 1: "done", 2: "done", 3: "done" });
  } finally {
    await h.cleanup();
  }
});

test("leer ficheros no completa tareas: hace falta mutación", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    await h.runStart();
    await h.toolResult("read", { path: "src/auth.ts" });
    await h.toolResult("read", { path: "README.md" });
    await h.turnEnd("He revisado el código existente.", "stop");
    await h.settle();
    const s = await h.statusByRef();
    assert.equal(s[3], "pending", "README sólo leído");
  } finally {
    await h.cleanup();
  }
});

test("lo que el modelo declara pendiente no se completa por evidencia", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    await h.runStart();
    await h.toolResult("edit", { path: "src/auth.ts" });
    await h.toolResult("edit", { path: "README.md" });
    await h.turnEnd("Autenticación JWT terminada en src/auth.ts. Queda pendiente actualizar el README con la nueva API.", "stop");
    await h.settle();
    const s = await h.statusByRef();
    assert.equal(s[1], "done");
    assert.notEqual(s[3], "done", "el modelo dijo explícitamente que el README queda pendiente");
  } finally {
    await h.cleanup();
  }
});

// ── Causa raíz #7: task_id literal → "Task not found" y la tarea quedaba pendiente
test("plan_manager complete acepta varios refs, rangos, texto y números", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);

    const multi = await h.tool({ action: "complete", task_id: "1,2" });
    assert.match(multi.content[0].text, /#1/);
    assert.match(multi.content[0].text, /#2/);

    const fuzzy = await h.tool({ action: "complete", task_id: "README con la nueva API" });
    assert.match(fuzzy.content[0].text, /#3/);
    assert.deepEqual(await h.statusByRef(), { 1: "done", 2: "done", 3: "done" });
  } finally {
    await h.cleanup();
  }
});

test("plan_manager complete con task_id numérico (number) no lanza", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    const res = await h.tool({ action: "complete", task_id: 2 });
    assert.match(res.content[0].text, /#2/);
    assert.equal((await h.statusByRef())[2], "done");
  } finally {
    await h.cleanup();
  }
});

test("plan_manager complete con texto aproximado resuelve por fuzzy", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    const res = await h.tool({ action: "complete", task_id: "JWT auth" });
    assert.match(res.content[0].text, /#1/);
  } finally {
    await h.cleanup();
  }
});

test("task_id inexistente devuelve la lista de refs para reintentar", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    const res = await h.tool({ action: "complete", task_id: "999" });
    assert.match(res.content[0].text, /Task not found/);
    assert.match(res.content[0].text, /#3 Actualizar README/);
  } finally {
    await h.cleanup();
  }
});

// ── Causa raíz #8: sólo se inyectaban 10 pendientes ─────────────────────────────
test("el contexto inyectado incluye todas las pendientes con su ref estable", async () => {
  const h = await createHarness();
  try {
    const many = Array.from({ length: 14 }, (_, i) => `Tarea número ${i + 1} del plan ampliado`);
    await h.addTasks(many);
    const res = await h.runStart();
    const content = res.message.content;
    for (let i = 1; i <= 14; i++) {
      assert.ok(content.includes(`#${i}.`), `falta #${i} en el contexto inyectado`);
    }
    assert.match(content, /Refs \(#n\) are stable/);
    assert.match(content, /plan_manager complete/);
  } finally {
    await h.cleanup();
  }
});

// ── Causa raíz #6: renumeración en caliente ─────────────────────────────────────
test("[DONE:3] sigue resolviendo aunque se borre la tarea 2 en el mismo turno", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    await h.runStart();
    await h.turnEnd(
      "Descartada la tarea 2 de tests, ya no hace falta. [DONE:3] Actualizado el README con la nueva API.",
      "stop"
    );
    const plan = await h.plan();
    const readme = plan.find((t) => t.text.includes("README"));
    assert.equal(readme.status, "done", `[DONE:3] debe resolver el ref estable 3: ${JSON.stringify(plan)}`);
    assert.equal(readme.ref, 3, "el ref no se renumera al borrar");
    assert.equal(plan.find((t) => t.text.includes("tests")), undefined, "la tarea descartada se borra");
  } finally {
    await h.cleanup();
  }
});

// ── Causa raíz #9: everTouched en bloque dejaba muerta la rama de descarte ──────
test("la conclusión completa lo activo y descarta lo que nadie tocó", async () => {
  const h = await createHarness();
  try {
    await h.addTasks([
      "Añadir autenticación JWT en src/auth.ts",
      "Tarea fantasma que nadie menciona nunca",
    ]);
    await h.runStart();
    await h.tool({ action: "start", task_id: "1" });
    await h.toolResult("edit", { path: "src/auth.ts" });
    await h.turnEnd("Ya está todo listo.", "stop");
    const plan = await h.plan();
    assert.equal(plan.length, 1, `la tarea sin tocar se descarta: ${JSON.stringify(plan)}`);
    assert.equal(plan[0].status, "done");
  } finally {
    await h.cleanup();
  }
});

// ── Causa raíz #10: persistir antes que pintar ──────────────────────────────────
test("si la UI lanza, el cambio de estado queda persistido en la sesión", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    await h.runStart();
    h.ctx.ui.setWidget = () => {
      throw new Error("stale ctx");
    };
    // updateUI lanza tras persistState(): el throw no debe impedir el guardado.
    let threw = false;
    try {
      await h.tool({ action: "complete", task_id: "2" });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "la UI debe haber lanzado (ctx stale simulado)");

    const persisted = h.entries.filter((e) => e.customType === "plan-state").pop();
    const saved = persisted.data.state.tasks.find((t) => t.ref === 2);
    assert.equal(saved.status, "done", "persistState() debe ir antes que updateUI()");
  } finally {
    await h.cleanup();
  }
});

// ── Round-trip del fichero de plan ──────────────────────────────────────────────
test("el fichero de plan refleja los estados y no se pierde al releerlo", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(TASKS);
    await h.runStart();
    await h.toolResult("edit", { path: "src/auth.ts" });
    await h.turnEnd("Autenticación JWT completada en src/auth.ts.", "stop");
    await h.settle();

    const md = await h.planFile();
    assert.match(md, /## ✅ Completed/);
    assert.match(md, /- \[x\] Añadir autenticación JWT/);

    const { extractPlanTasks } = await import("../src/utils.ts");
    const reparsed = extractPlanTasks(md);
    const auth = reparsed.find((t) => t.text.includes("autenticación"));
    assert.equal(auth.status, "done", "el markdown debe conservar el estado al releerlo");
  } finally {
    await h.cleanup();
  }
});
