# Diagnóstico: tareas completadas que quedan como pendientes

Fecha: 2026-09-05 · Versión analizada: 1.0.4 (commit 7f9b091)
Método: lectura de `src/runtime.ts` + `src/utils.ts`, verificación de la semántica de eventos
en `pi-coding-agent/dist/core/agent-session.js` y `docs/extensions.md`, y batería de pruebas
ejecutando las funciones reales de detección con salidas típicas de un agente (ES/EN).

## Resumen

No es un bug aislado: la única vía fiable (que el modelo llame a `plan_manager complete` o
escriba `[DONE:n]`) es opcional, y **todas** las vías de respaldo fallan a la vez. Además, el
último evento del ciclo (`agent_settled`) **reescribe a `pending` las tareas en progreso** en
cada ejecución, incluso cuando todo ha ido bien — es la última escritura del run, así que
anula lo que `turn_end` hubiera acertado.

## Causa raíz #1 (P0) — `agent_settled` resetea `in_progress → pending` en TODOS los runs

`src/runtime.ts:1433-1451`

```ts
const onAgentSettled = async (_event, ctx) => {
  const stillActive = state.tasks.filter((t) => t.status === "in_progress");
  ...
  for (const task of stillActive) markTaskStatus(task.id, "pending", ctx);  // ⏸ paused
  persistState(); await writePlanFile(ctx.cwd);
```

El código asume que `agent_settled` significa "el agente se detuvo a medias". Falso:
en pi se emite en un `finally` después de **cualquier** run (éxito, aborto o error):

```js
// pi-coding-agent/dist/core/agent-session.js:773-786
this._isAgentRunActive = true;
try { await this.agent.prompt(messages); while (await this._handlePostAgentRun()) await this.agent.continue(); }
finally { ...; await this._emitAgentSettled(); }
```

Documentación (`docs/extensions.md:567`): *"`agent_end` fires when that run ends, but Pi may
still auto-retry… Use `agent_settled` for status integrations that need to know Pi will not
continue running automatically."* → no distingue éxito de interrupción.

Efecto: la tarea en la que el agente estaba trabajando (la que casi acaba de terminar) se
devuelve a `pending`, se persiste en el `plan_*.md` y se reinyecta como `Todo:` en el
siguiente `before_agent_start`. Orden del ciclo: `turn_end → agent_end → agent_settled`.

## Causa raíz #2 (P0) — El detector difuso ignora la mayoría de resúmenes reales

`src/utils.ts:820-870` (`detectAutoTransitions`) encadena tres filtros, y los tres fallan:

**a) El segmento debe contener un verbo de `COMPLETION_PATTERN` (`utils.ts:500`).**
Faltan ~20 participios españoles de uso constante. Medido con el código real:

```
IGNORA actualizado · escritos · pasando · probado · verificado · documentado · desplegado
IGNORA refactorizado · mejorado · migrado · cubierto · funciona · corregido · integrado
IGNORA configurado · generado · ejecutado · validado · "añadida la sección" · "listo para revisar"
```

**b) Los segmentos de más de 300 caracteres se descartan en silencio (`utils.ts:827`).**
Resumen real de 373 chars en una sola frase → se tira un trozo de 329 chars → las tareas 2 y 3
ni se evalúan:

```
seg(44):  "He añadido la autenticación JWT en src/auth."   → task1 score=1.000 ✓
seg(329): <<DESCARTADO por len>300>>                        → task2/task3 invisibles
```

**c) Umbral `>= 0.55` sobre `recall*0.7 + precision*0.3` (`utils.ts:864`), con `>` estricto en
`bestMatch` (`utils.ts:815`).** Caso de libro que falla por épsilon de coma flotante:

```
"Completada la autenticación JWT." vs "Añadir autenticación JWT en src/auth.ts"
score exacto = 0.5499999999999999  →  >= 0.55 ? false
```

Y las frases multi-tarea diluyen la precisión:

```
"Done. Implemented JWT auth, added tests for /login, updated the README."
  task1 0.637 ✓   task2 0.425 ✗   task3 0.212 ✗     (el modelo dijo explícitamente las tres)
```

Resultado global con un cierre perfecto en español:

```
"Completada la autenticación JWT. Tests del endpoint /login escritos y pasando. README actualizado."
=> completedIds = []        ← exactamente el síntoma reportado
```

Y con el resumen en bullets habitual (sin verbo de completitud por línea):

```
"Listo. Cambios:\n- src/auth.ts: JWT…\n- tests/login.test.ts: 8 casos…\n- README.md: sección actualizada"
=> completedIds = [] · workConclusion = false · genericCompletion = false
```

## Causa raíz #3 (P0) — La evidencia de herramientas nunca completa nada

`utils.ts:880-907`: el corpus de herramientas (nombres + args + 400 chars de cada resultado)
sólo puede marcar **una** tarea (`best`) y sólo a `in_progress` (`startedIds`). Verificado:

```
corpus: edit src/auth.ts · write tests/login.test.ts · bash npx vitest run · edit README.md
=> completed: []   started: ['a']  (una sola tarea, y #1 la devolverá a pending al settling)
```

Es la señal más fuerte y determinista disponible (qué ficheros tocó realmente) y está
infrautilizada.

## Causa raíz #4 (P1) — El stemmer se aplica ANTES de la tabla de sinónimos

`utils.ts:536-546` (`stem`), `587` (`normalizeToken`), `606-619` (`tokenize`):
`tokens.add(normalizeToken(stem(w)))`. Como `stem("terminado") → "termin"`, las claves
`terminado`, `purgar`, `eliminar`, `guardar`, `buscar`, `configurar`… de `SYNONYMS` son
inalcanzables. Medido:

```
0.000 terminado ↔ finished     0.000 eliminar ↔ remove     0.000 guardar ↔ save
0.000 buscar ↔ search          0.500 purgar ↔ purge        0.500 escribir ↔ write
```

El emparejamiento ES↔EN (justificado en el README) está roto en la práctica.

## Causa raíz #5 (P1) — `[DONE:n]` sólo acepta un identificador

`utils.ts:448-460`: `parseInt(identifier)` sobre la captura completa.

```
"[DONE:1]"          → ["a"]          ✓
"[DONE:1,2,3]"      → ["a"]          ✗ (2 y 3 se pierden)
"[DONE: 1, 2, 3]"   → ["a"]          ✗
"[DONE:1 2 3]"      → ["a"]          ✗
"[DONE:all]"        → []             ✗
"[DONE:1], [DONE:2], [DONE:3]" → ["a","b","c"] ✓ (el único formato que funciona)
```

## Causa raíz #6 (P1) — La numeración no es estable durante el run

El modelo recibe la numeración en `before_agent_start` (`runtime.ts:1185-1240`), pero
`removeTask` (`runtime.ts:413`) y `reconcilePlanTasks` (`nextTasks.forEach((t,i)=>t.order=i+1)`)
renumeran en caliente. Además `detectRemovedTasks` se ejecuta **antes** que
`parseDoneMarkers` sobre el mismo texto (`runtime.ts:1320` vs `1329`). Verificado:

```
plan original: 1 auth · 2 tests · 3 README
se descarta la 2 → 1 auth · 2 README
el modelo escribe [DONE:3] (su numeración) → parseDoneMarkers => []   (README sigue pendiente)
```

## Causa raíz #7 (P1) — `findTaskByIdentifier` es demasiado literal

`runtime.ts:959-972`: id exacto → `parseInt` por orden → `text.toLowerCase().includes(identifier)`.
`task_id="JWT auth"` no encuentra "Añadir autenticación JWT en src/auth.ts"; la herramienta
responde "Task not found" y el modelo normalmente no reintenta → tarea pendiente.
Extra: si el modelo manda `task_id: 3` (número) y el orden no existe, `identifier.toLowerCase()`
lanza `TypeError` y revienta la llamada completa.

## Causa raíz #8 (P1) — El modelo no ve el plan completo

`runtime.ts:1220`: sólo se inyectan las 10 primeras pendientes (`pending.slice(0, 10)`);
`runtime.ts:1227`: las completadas se resumen como `Done: N`. Con más de 10 tareas, la 11+
es invisible (nunca se puede completar) y el modelo no sabe cuáles ya están hechas.

## Causa raíz #9 (P2) — Las dos redes de seguridad se anulan entre sí

- `detectWorkConclusion` / `detectGenericCompletion` tienen veto duro por
  `CONTINUATION_*` / `SCOPE_LIMIT_*`, que incluyen palabras presentes en casi todo cierre real
  ("queda", "falta", "pendiente", "aún", "todavía", "siguiente paso", "next step", "for now",
  "so far", "yet", "remaining"). Medido:

```
CONCLUSION "Ya está todo listo."
no         "Listo, commit y push hechos."
no         "Ya quedó."
no         "Todo completado. Queda pendiente el despliegue."
no         "Implementación completa. El siguiente paso sería añadir tests."
```

- `everTouched` se pone a `true` **en bloque** al crear el plan (`runtime.ts:1253`) y en cada
  reconcile (`runtime.ts:1300`). Por tanto la rama "descartar pendientes untouched"
  (commit 5bd88ec) es código muerto y, cuando la conclusión sí dispara, se marcan **todas**
  las pendientes como hechas (fallo contrario: sobre-completitud).

## Causa raíz #10 (P2) — Errores silenciados y orden de persistencia incorrecto

Todos los hooks son un único `try { … } catch {}` sin log. En `onTurnEnd`
(`runtime.ts:1400-1410`) el orden es `updateUI(ctx); persistState(); writePlanFile()`: si la UI
lanza (ctx stale tras reload), las mutaciones de estado ya hechas no se persisten y se pierden
al recargar. Sin logs, nada de esto es depurable.

---

## Solución

### P0 — elimina el síntoma

1. **`agent_settled` consciente del aborto.** Guardar `lastStopReason` en `onTurnEnd`
   (`event.message.stopReason`, tipo `StopReason = "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"`)
   y sólo degradar a `pending` si el run fue `"aborted"`/`"error"`. En settle normal, no tocar
   `in_progress`: resolverlo con la evidencia del run.
2. **Evidencia de herramientas determinista.** Suscribirse a `tool_result` (los eventos tipados
   traen `input` con los args exactos: `path`, `command`, `content`) y acumular por run el
   conjunto de ficheros/comandos tocados. Extraer de cada tarea su "firma de artefactos"
   (rutas, `basenames`, `/rutas`, tokens entre backticks) y compararla con ese conjunto:
   si la tarea sólo se cubre con herramientas de mutación (`edit`/`write`/`bash`), marcarla
   `done`. Permitir avanzar **varias** tareas por turno. Esto es independiente del idioma y no
   depende de la prosa del modelo.
3. **Arreglar el detector difuso:**
   - dividir los segmentos largos por `[,;:]| — |\b(?:y|and)\b` en vez de descartar lo >300;
   - puntuar por cláusula (no por frase multi-tarea) para no diluir la precisión;
   - invertir la lógica del gate: sin verbo exigir score ≥ 0.80; con verbo bajar a 0.55;
   - comparaciones con tolerancia (`>= 0.55 - 1e-9`) y `>` → `>=` en `bestMatch`;
   - completar `COMPLETION_PATTERN` con los participios que faltan.
4. **`[DONE:…]` multi-id.** Partir la captura por `[,;/\s]+`, soportar `all|todo|*` y rangos
   `2-4`, y resolver cada parte por ref/id/texto difuso.

### P1 — evita que se repita

5. **Referencias estables:** añadir `ref` (asignado una vez, nunca renumerado) y usarlo en el
   contexto inyectado, en `[DONE:ref]` y en `task_id`; `order` queda sólo para pintar.
   Resolver los marcadores sobre un *snapshot* tomado al inicio del turno, antes de aplicar
   borrados/reconciliaciones.
6. **`findTaskByIdentifier` con fallback difuso** (`taskTextScore ≥ 0.6`, mejor candidato) y,
   si falla, devolver la lista numerada actual para que el modelo reintente en el mismo turno.
   `String(identifier)` para evitar el `TypeError`.
7. **Inyectar el plan completo** (todas las pendientes + resumen breve de las hechas) y una
   instrucción explícita: "antes de cerrar el turno, llama a `plan_manager complete` por cada
   tarea terminada".

### P2 — higiene

8. `everTouched` sólo con evidencia por tarea (nunca en bloque); así la conclusión puede
   marcar hechas las que tienen evidencia y descartar el resto, que era la intención original.
9. Sustituir el veto duro de continuación por análisis por cláusula.
10. Loguear lo capturado en los `catch {}` a `~/.pi/agent/t-plan/debug.log` (flag `debug` en
    config) y reordenar a `persistState() → writePlanFile() → updateUI() → notify()`.

### Alternativa estructural (recomendada a medio plazo)

Dejar de *adivinar* y convertir la detección en *recordatorio*: el modelo es la única fuente de
verdad vía `plan_manager`, y si al llegar a `agent_settled` (stop normal) hay tareas
`in_progress`/`pending` con evidencia de herramienta, se inyecta un mensaje de seguimiento
(`ctx.sendUserMessage` / custom message) o se avisa al usuario, en lugar de degradarlas en
silencio. Así el fallo pasa de "estado incorrecto invisible" a "una pregunta explícita".

---

## ✅ Solución aplicada (v1.1.0)

P0, P1 y P2 implementados en `src/` con suite de regresión en `tests/` (`npm test`,
34 tests). Cambios por causa raíz:

1. **`agent_settled` abort-aware** (`runtime.ts`): se captura `stopReason` en cada
   `turn_end` y sólo un run `"aborted"|"error"` revierte `in_progress → pending`. En
   settle normal, la evidencia de herramientas cierra las tareas tocadas.
2. **Evidencia determinista** (`utils.ts` + hook `tool_result` en `index.ts`): cada
   llamada registra rutas/comandos reales (los args tipados, sin los recortes de antes);
   las mutaciones (`edit`/`write`/…), los comandos (`bash`) y los test-runs
   (`vitest|jest|tsc|…`) puntúan por artefacto de la tarea (ficheros, rutas, basenames,
   identificadores). Varias tareas avanzan por turno; leer solo nunca completa.
3. **Detector difuso corregido**: segmentos partidos por cláusula (nunca se descartan
   >300 chars), umbral con tolerancia de épsilon, ~30 participios ES añadidos al gate,
   veto de fallo ("no funciona") salvo verbo fuerte de arreglo, y sin rama "sin verbo"
   (completaba frases de trabajo en curso; lo cubre la evidencia).
4. **Sinónimos antes que stemmer**: `normalizeToken` prueba la forma exacta y luego el
   stem; claves canónicas por stem para ES y EN (`terminado↔finished = 1.00`).
5. **`[DONE:…]` multi-id**: listas, rangos, `#ref`, `all|todo|*` y texto.
6. **Refs estables**: `ref` asignado una vez (nunca renumerado); `[DONE:]`, `task_id`,
   contexto inyectado y listados usan `#ref`. Los marcadores del turno se resuelven
   sobre un snapshot previo a borrados/reconciliación; `detectRemovedTasks` no borra
   tareas recién completadas en el mismo texto.
7. **`findTaskByIdentifier` con fallback difuso** + `resolveTaskIds` (listas/rangos/
   `all`), sin `TypeError` con `task_id` numérico, y devuelve la lista de refs cuando
   no resuelve.
8. **Plan completo inyectado**: todas las pendientes (cap 40) con `#ref`, hechas con
   sus refs, y la orden explícita de llamar a `complete` antes de cerrar turno.
9. **`everTouched` sólo por evidencia por tarea** (nunca en bloque): la conclusión
   marca done lo activo/con evidencia, conserva lo declarado pendiente y descarta sólo
   lo que nadie tocó. Conclusión evaluada por cláusulas (un cierre con "queda
   pendiente X" ya no veta todo).
10. **Higiene**: `persistState() → writePlanFile() → updateUI()` (un throw de la UI ya
    no pierde estado), `catch {}` con log a `~/.pi/agent/t-plan/debug.log` cuando
    `debug: true`, y 5 errores TS preexistentes corregidos.
