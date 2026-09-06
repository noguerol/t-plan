# Diagnóstico: tareas acabadas que quedan «en proceso» con el timer corriendo

Fecha: 2026-09-06 · Versión analizada: 1.1.0 (commit 3d575e4)
Método: análisis de la sesión real `pi-poke/2026-09-05T15-35-03-974Z_01a07235` (activa
el mismo día a las 12:39, con una tarea clavada en `in_progress`), reproducción en el
harness y verificación de los eventos reales de pi (`turn_end`/`agent_settled`).

## Síntoma (lo que ve el usuario)

El agente termina la tarea y los turnos, pero las tareas siguen **activas** (🔄) y con el
**timer avanzando** (⏱) — de forma sistemática y en todos los proyectos (t-plan está
instalado globalmente vía `~/.pi/agent/extensions/plan → /home/j/repos/t-plan`).

## Evidencia real

En la sesión de pi-poke, el último run termina con `stop` y un resumen inequívoco para
un humano — y, pese a ello, dos tareas quedan `in_progress` desde las 12:39:28:

```
Ya estaba commiteado y pusheado — el commit `659f711` se hizo en el turno anterior al
terminar el fix. Verificado ahora:
- Working tree: limpio, sin cambios pendientes.
- npm: pi-poke@1.2.7 ya publicado.
No queda nada pendiente por commitear ni pushear. El fix … está cerrado y desplegado.
```

Los plan-state persistidos muestran las tareas #1/#2 `in_progress started=12:39:28`,
sin que ningún evento posterior las cierre.

## Causas raíz (todas compuestas)

### P0 — La reconciliación crea tareas fantasma desde la prosa numerada del resumen
`containsPlan` da true con ≥3 líneas numeradas (`1. … 2. … 3. …`), que es como el modelo
escribe sus diagnósticos. `hasPlanRefreshCue` se dispara con palabras sueltas
(`actualizados`, `pendiente`) presentes en cualquier resumen. Resultado: los 3 puntos
del diagnóstico del propio resumen final se convierten en tareas nuevas, la evidencia de
lectura (grep/sed/curl) las marca `in_progress` y nadie las cierra jamás.

### P1 — Los cierres reales de sesión no matchean ningún patrón
Faltaban: imperfecto («ya **estaba** commiteado»; los patrones sólo tenían «está»),
grafía real «**commiteado/pusheado**» (sólo existía «comiteado», con una m), git limpio
en prosa («Working tree: limpio, sin cambios pendientes»), «no queda nada pendiente por
commitear ni pushear», «está cerrado y desplegado», «ya publicado», y el cierre en
inicio de línea «Arreglado ✅ …».

### P2 — `in_progress` sobrevive a la inactividad
En un settle **normal** (stop) el agente queda idle, pero las tareas en curso no
trabajadas en el run seguían `in_progress` con el timer contando tiempo muerto entre
mensajes, runs ajenos y hasta reinicios de sesión (el `startedAt` se restauraba).

## Cambios (v1.2.0)

1. **`hasRealPlanStructure(text)`** — reconciliar exige estructura real (cabeceras de
   sección, estados, checkboxes, `[PLAN]`). La prosa numerada ya no crea tareas. La
   adopción inicial (plan vacío) sigue usando `containsPlan` sin exigencia extra.
2. **`WRAP_UP_PATTERN` + veto de negación** — nuevos cierres (imperfecto, doble eme,
   git limpio, «no queda nada pendiente», «está cerrado y desplegado», «ya publicado»,
   «Arreglado ✅…») integrados en `detectWorkConclusionClauses` /
   `detectGenericCompletion`; `NEGATED_CLOSER` impide concluir con «no está hecho
   todavía», «aún no he commiteado», «working tree no limpio»…
3. **Settle normal: park** — al asentarse un run normal, las tareas que siguen
   `in_progress`, no son de agente (trimegisto) y el texto final no las mantiene
   activas («sigo con…», «continúo…») vuelven a `pending` → el timer se detiene.
4. **Restauración de sesión** — lo que quedó `in_progress` en otra vida de la sesión
   se aparca a `pending` (sin timers heredados).

## Regresión

43 tests (node:test) verdes: los 3 nuevos escenarios de runtime reproducen las
secuencias reales (resumen con bullets + «actualizados» sin tareas fantasma; cierre
wrap-up real completa lo activo aunque el run sólo verifique con git; settle idle →
pending) y 5 tests de detección (patrones wrap-up, veto, `hasRealPlanStructure`).
