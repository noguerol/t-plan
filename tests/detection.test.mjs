import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";

let u;

before(async () => {
  await ensurePeers();
  u = await import("../src/utils.ts");
});

const mkTasks = () => [
  { id: "a", ref: 1, text: "Añadir autenticación JWT en src/auth.ts", status: "pending", order: 1 },
  { id: "b", ref: 2, text: "Escribir tests del endpoint /login", status: "pending", order: 2 },
  { id: "c", ref: 3, text: "Actualizar README con la nueva API", status: "pending", order: 3 },
];

// ── Causa #5: [DONE:n] sólo aceptaba un identificador ──────────────────────────
test("[DONE:…] acepta listas, rangos, refs con #, 'all' y texto", () => {
  const cases = {
    "[DONE:1]": ["a"],
    "[DONE:1,2,3]": ["a", "b", "c"],
    "[DONE: 1, 2, 3]": ["a", "b", "c"],
    "[DONE:1 2 3]": ["a", "b", "c"],
    "[DONE:2-3]": ["b", "c"],
    "[DONE:#2]": ["b"],
    "[DONE:all]": ["a", "b", "c"],
    "[DONE:todo]": ["a", "b", "c"],
    "[DONE:1], [DONE:2], [DONE:3]": ["a", "b", "c"],
    "[done:2]": ["b"],
  };
  for (const [marker, expected] of Object.entries(cases)) {
    assert.deepEqual(u.parseDoneMarkers(marker, mkTasks()), expected, marker);
  }
});

test("[DONE:…] resuelve por texto cuando no hay número", () => {
  const ids = u.parseDoneMarkers("[DONE: README con la nueva API]", mkTasks());
  assert.deepEqual(ids, ["c"]);
});

test("[DONE:] vacío no marca nada", () => {
  assert.deepEqual(u.parseDoneMarkers("[DONE:]", mkTasks()), []);
});

// ── Causa #2: el detector difuso ignoraba resúmenes reales ──────────────────────
const SUMMARIES = {
  "prosa larga (>300 chars, antes se descartaba)":
    "He añadido la autenticación JWT en src/auth.ts con refresh tokens y rotación, he escrito los tests del endpoint /login cubriendo expiración, firma inválida, rate limiting y credenciales incorrectas con 8 casos que pasan correctamente, y también he actualizado el README con la nueva sección de autenticación documentando los endpoints y las variables de entorno necesarias.",
  "cierre perfecto en español (antes fallaba por épsilon y por gate de verbo)":
    "Completada la autenticación JWT en src/auth.ts. Tests del endpoint /login escritos y pasando. README actualizado con la nueva API.",
  "inglés multi-tarea en una frase":
    "Done. Implemented JWT auth in src/auth.ts, added tests for the /login endpoint, updated the README with the new API section.",
  "checklist":
    "## Resumen\n- [x] Añadir autenticación JWT en src/auth.ts\n- [x] Escribir tests del endpoint /login\n- [x] Actualizar README con la nueva API",
};

for (const [name, text] of Object.entries(SUMMARIES)) {
  test(`detecta las 3 tareas completadas en: ${name}`, () => {
    const r = u.detectAutoTransitions(text, "", mkTasks());
    assert.deepEqual([...r.completedIds].sort(), ["a", "b", "c"], `completedIds=${r.completedIds}`);
  });
}

test("no completa tareas a partir de un plan reemitido todavía pendiente", () => {
  const text = "## Plan actualizado\n\n- [ ] Añadir autenticación JWT en src/auth.ts\n- [ ] Escribir tests del endpoint /login\n- [ ] Actualizar README con la nueva API";
  const r = u.detectAutoTransitions(text, "", mkTasks());
  assert.deepEqual(r.completedIds, []);
});

test("no completa cuando la cláusula describe un fallo", () => {
  const text = "No funciona la autenticación JWT en src/auth.ts, sigue dando 401.";
  const r = u.detectAutoTransitions(text, "", mkTasks());
  assert.deepEqual(r.completedIds, []);
});

test("sí completa cuando el fallo se describe como arreglado", () => {
  const text = "Arreglado el fallo de la autenticación JWT en src/auth.ts.";
  const r = u.detectAutoTransitions(text, "", mkTasks());
  assert.ok(r.completedIds.includes("a"), `completedIds=${r.completedIds}`);
});

test("splitSegments no descarta texto largo", () => {
  const long = "x".repeat(400);
  const segments = u.splitSegments(`frase corta. ${long}`);
  assert.ok(segments.some((s) => s.includes("xxxxx")), "el texto largo debe aparecer");
  assert.ok(segments.join("").length >= 400);
});

// ── Causa #4: stemmer antes de sinónimos (ES↔EN roto) ───────────────────────────
test("emparejamiento ES↔EN tras normalizar antes que stemear", () => {
  const pairs = [
    ["terminado", "finished"],
    ["eliminar el fichero", "remove the file"],
    ["guardar el estado", "save the state"],
    ["buscar en el índice", "search the index"],
    ["purgar la caché", "purge the cache"],
    ["escribir tests", "write tests"],
    ["actualizar el readme", "update the readme"],
    ["desplegado en producción", "deployed to production"],
  ];
  for (const [es, en] of pairs) {
    assert.ok(u.taskTextScore(es, en) >= 0.5, `${es} <-> ${en} = ${u.taskTextScore(es, en)}`);
  }
});

// ── Causa #3: la evidencia de herramientas nunca completaba nada ────────────────
test("la evidencia de herramientas completa varias tareas a la vez", () => {
  const ev = u.createEvidence();
  u.recordToolEvidence(ev, "edit", { path: "src/auth.ts" }, false);
  u.recordToolEvidence(ev, "write", { path: "tests/login.test.ts" }, false);
  u.recordToolEvidence(ev, "bash", { command: "npx vitest run tests/login.test.ts" }, false);
  u.recordToolEvidence(ev, "edit", { path: "README.md" }, false);

  const mid = u.detectEvidenceTransitions(mkTasks(), ev, { complete: false });
  assert.deepEqual(mid.completedIds, [], "durante el turno sólo avanza a in_progress");
  assert.ok(mid.startedIds.length >= 2, `startedIds=${mid.startedIds}`);

  const end = u.detectEvidenceTransitions(mkTasks(), ev, { complete: true });
  assert.deepEqual([...end.completedIds].sort(), ["a", "b", "c"], `completedIds=${end.completedIds}`);
});

test("leer un fichero no completa la tarea; editarlo sí", () => {
  const read = u.createEvidence();
  u.recordToolEvidence(read, "read", { path: "README.md" }, false);
  assert.deepEqual(u.detectEvidenceTransitions(mkTasks(), read, { complete: true }).completedIds, []);

  const write = u.createEvidence();
  u.recordToolEvidence(write, "edit", { path: "README.md" }, false);
  assert.deepEqual(u.detectEvidenceTransitions(mkTasks(), write, { complete: true }).completedIds, ["c"]);
});

test("una herramienta fallida no cuenta como evidencia", () => {
  const ev = u.createEvidence();
  u.recordToolEvidence(ev, "edit", { path: "README.md" }, true);
  assert.deepEqual(u.detectEvidenceTransitions(mkTasks(), ev, { complete: true }).completedIds, []);
});

test("bash sin mutación no completa, pero ejecutar los tests de la tarea sí", () => {
  const ev = u.createEvidence();
  u.recordToolEvidence(ev, "bash", { command: "npx vitest run tests/login.test.ts" }, false);
  const r = u.detectEvidenceTransitions(mkTasks(), ev, { complete: true });
  assert.ok(r.completedIds.includes("b"), `completedIds=${r.completedIds}`);
  assert.ok(!r.completedIds.includes("a"), "auth no se tocó");
});

// ── Causa #9: veto global de continuación vs. análisis por cláusula ─────────────
test("detectWorkConclusionClauses separa lo terminado de lo que queda", () => {
  const r = u.detectWorkConclusionClauses("Listo, commit y push hechos. Queda pendiente el despliegue en producción.");
  assert.equal(r.conclusion, true);
  assert.equal(r.continuation, true);
});

test("detectPendingMentions marca lo que el modelo declara pendiente", () => {
  const ids = u.detectPendingMentions("Todo listo. Queda pendiente actualizar el README con la nueva API.", mkTasks());
  assert.deepEqual(ids, ["c"]);
});

// ── Causa #6: refs estables frente a renumeración ───────────────────────────────
test("assignRefs asigna refs estables y reconcile los conserva", () => {
  const tasks = mkTasks().map(({ ref: _ref, ...t }) => ({ ...t }));
  u.assignRefs(tasks);
  assert.deepEqual(tasks.map((t) => t.ref), [1, 2, 3]);

  const refreshed = [
    { id: "x", ref: 0, text: "Actualizar README con la nueva API", status: "pending", order: 1 },
    { id: "y", ref: 0, text: "Desplegar en producción", status: "pending", order: 2 },
  ];
  const res = u.reconcilePlanTasks([tasks[2]], refreshed);
  assert.equal(res.tasks[0].ref, 3, "la tarea emparejada conserva su ref");
  assert.notEqual(res.tasks[1].ref, res.tasks[0].ref, "la nueva recibe otro ref");
});

test("borrar una tarea no renumera los refs de las demás", () => {
  const tasks = mkTasks();
  const surviving = tasks.filter((t) => t.ref !== 2);
  assert.deepEqual(surviving.map((t) => t.ref), [1, 3]);
  assert.deepEqual(u.parseDoneMarkers("[DONE:3]", surviving), ["c"]);
});
