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

// ── v1.2.0: cierres reales de sesión (wrap-up) ─────────────────────────────────

test("wrap-up real: commiteado/pusheado/working tree limpio/no queda nada pendiente", () => {
  const text = [
    "Ya estaba commiteado y pusheado — el commit `659f711` se hizo en el turno anterior al terminar el fix. Verificado ahora:",
    "- **Working tree**: limpio, sin cambios pendientes.",
    "- **npm**: `pi-poke@1.2.7` ya publicado.",
    "No queda nada pendiente por commitear ni pushear. El fix del poke manual (interrupt + resume) está cerrado y desplegado. ¿Seguimos con otra mejora?",
  ].join("\n");
  const r = u.detectWorkConclusionClauses(text);
  assert.equal(r.conclusion, true, JSON.stringify(r));
});

test("wrap-up: 'Arreglado ✅ …' al inicio de línea cierra la sesión", () => {
  assert.equal(u.detectWorkConclusionClauses("Arreglado ✅ Commit 659f711 en main (npm publicará pi-poke@1.2.7).").conclusion, true);
});

test("no cierra cuando la cláusula dice que AÚN no está", () => {
  for (const text of [
    "No está hecho todavía, sigo trabajando.",
    "El despliegue no está terminado.",
    "Aún no he commiteado los cambios.",
    "Working tree no limpio, hay cambios sin commitear.",
  ]) {
    assert.equal(u.detectWorkConclusionClauses(text).conclusion, false, text);
  }
});

test("no cierra por 'no queda nada pendiente' aunque contenga la palabra pendiente", () => {
  assert.equal(u.detectWorkConclusionClauses("Listo. No queda nada pendiente por commitear ni pushear.").conclusion, true);
});

test("hasRealPlanStructure distingue un plan de la prosa numerada", () => {
  const prose = "Resumen del diagnóstico:\n1. Mientras hay un run activo (isStreaming es true incluso durante tool calls)…\n2. Y peor: cuando el run se aborta, pi hace restoreQueuedMessagesToEditor…\n3. Esc funciona porque abortHandler mata el run.\nREADME y TEST.md actualizados.";
  assert.equal(u.hasRealPlanStructure(prose), false, "la prosa numerada no es un plan");
  assert.equal(u.hasRealPlanStructure("## Todo\n1. Añadir JWT\n2. Escribir tests\n3. README"), true);
  assert.equal(u.hasRealPlanStructure("## Resumen\n- [x] Añadir JWT en src/auth.ts\n- [x] Escribir tests"), true);
  assert.equal(u.hasRealPlanStructure("## Done\n- [x] Tarea hecha"), true);
});

// ── v1.2.1: los mismos cierres en inglés ───────────────────────────────────────

test("wrap-up en inglés: already committed and pushed / fix is closed / working tree clean", () => {
  const texts = [
    "Already committed and pushed — the commit 659f711 landed in the previous turn.",
    "The manual poke fix is closed and deployed.",
    "Working tree is clean, no pending changes.",
    "All committed and pushed to main.",
    "npm: pi-poke@1.2.7 already published.",
    "Resolved. Everything is wrapped up.",
    "Everything is all set.",
  ];
  for (const text of texts) {
    const r = u.detectWorkConclusionClauses(text);
    assert.equal(r.conclusion, true, `EN wrap-up debería cerrar: ${text} → ${JSON.stringify(r)}`);
  }
});

test("wrap-up en inglés: 'Fixed ✅ …' / 'Done. …' al inicio de línea", () => {
  assert.equal(u.detectWorkConclusionClauses("Fixed ✅ Commit 659f711 on main (npm will publish pi-poke@1.2.7).").conclusion, true);
  assert.equal(u.detectWorkConclusionClauses("Done. Implemented JWT auth, added tests, updated the README.").conclusion, true);
});

test("veto en inglés: 'not yet' / 'not deployed' / mixto con trabajo pendiente no cierra", () => {
  for (const text of [
    "Not done yet — will push after review.",
    "The fix is not deployed yet.",
    "Working tree is not clean.",
    "We committed and pushed the fix, but the deploy is pending.",
  ]) {
    assert.equal(u.detectWorkConclusionClauses(text).conclusion, false, text);
  }
});

test("artifactSet no entra en bucle infinito con puntos suspensivos o puntos terminales", () => {
  const cases = [
    "...src.matchAll",
    "const values = [...src.matchAll(/value: \\\"(\\\\w+)\\\" as const/g)].map(m=>m[1]);",
    "file...",
    "a.b.",
    "foo..bar",
    "DEV=0/DEV=2.",
    "/path/to/script.sh.bak-20260906",
  ];
  for (const c of cases) {
    const res = u.artifactSet(c);
    assert.ok(res.all instanceof Set, `artifactSet falló en: ${c}`);
  }
});

