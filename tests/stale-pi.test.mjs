/**
 * Regresión: tras newSession/fork/switchSession/reload, pi re-ejecuta la factory
 * con un `pi` NUEVO e invalida el viejo (appendEntry lanza "ctx stale"). El
 * runtime está cacheado, así que debe re-vincularse al `pi` vivo vía setPi().
 *
 * Dos capas de defensa:
 *   (1) setPi() re-vincula al `pi` nuevo → appendEntry vuelve a funcionar.
 *   (2) aunque el runtime siga apuntando a un `pi` stale, persistState() NO debe
 *       tumbar la llamada a plan_manager (degrada, no lanza).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";

await ensurePeers();

const { createPlanRuntime } = await import("../src/runtime.ts");

function makeCtx(cwd, entries, sessionId = "sess-stale") {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      theme: {
        bold: (s) => s,
        fg: (_c, s) => s,
        bg: (_c, s) => s,
        strikethrough: (s) => s,
      },
      select: async () => undefined,
      confirm: async () => true,
      input: async () => "",
      width: 80,
      abort: async () => {},
      sendUserMessage: async () => {},
      custom: { editCommands: [], editSelected: 0 },
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
  };
}

function makePi() {
  const entries = [];
  const pi = {
    entries,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  return pi;
}

/** Simula que pi invalidó este `pi` (session replacement/reload). */
function invalidate(pi) {
  pi.appendEntry = () => {
    throw new Error("This extension ctx is stale after session replacement or reload.");
  };
}

test("setPi() re-vincula al `pi` vivo: appendEntry deja de lanzar y persiste en la sesión nueva", async () => {
  const prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "tplan-stale-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "tplan-stale-cwd-"));
  try {
    const count = (pi) => pi.entries.filter((e) => e.customType === "plan-state").length;
    const piOld = makePi();
    const rt = createPlanRuntime(piOld);
    const ctx = makeCtx(cwd, piOld.entries);
    await rt.onSessionStart({}, ctx);
    const baseOld = count(piOld); // onSessionStart ya persiste una vez

    // Un plan_manager normal persiste en el `pi` viejo.
    await rt.planManagerTool.execute("c1", { action: "add", task_text: "tarea A" }, undefined, undefined, ctx);
    assert.equal(count(piOld), baseOld + 1, "persiste en el pi original");

    // Session replacement: el `pi` viejo queda stale y llega uno nuevo.
    invalidate(piOld);
    const piNew = makePi();
    rt.setPi(piNew);

    // La siguiente llamada a plan_manager NO debe lanzar y debe persistir en el `pi` nuevo.
    let threw = false;
    try {
      await rt.planManagerTool.execute("c2", { action: "add", task_text: "tarea B" }, undefined, undefined, ctx);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "plan_manager no debe lanzar tras rebind");
    assert.equal(count(piNew), 1, "appendEntry debe ir al `pi` vivo tras setPi()");
    assert.equal(count(piOld), baseOld + 1, "el `pi` stale no debe recibir más writes");
  } finally {
    process.env.HOME = prevHome;
  }
});

test("sin setPi, un `pi` stale degrada (no lanza) la llamada a plan_manager", async () => {
  const prevHome = process.env.HOME;
  process.env.HOME = await mkdtemp(join(tmpdir(), "tplan-stale-home-"));
  const cwd = await mkdtemp(join(tmpdir(), "tplan-stale-cwd-"));
  try {
    const piOld = makePi();
    const rt = createPlanRuntime(piOld);
    const ctx = makeCtx(cwd, piOld.entries);
    await rt.onSessionStart({}, ctx);

    // Sin rebind: el `pi` queda stale. La llamada no debe tumbarse; el plan file
    // sigue escribiéndose y el resultado del tool es normal.
    invalidate(piOld);
    let threw = false;
    let res;
    try {
      res = await rt.planManagerTool.execute("c1", { action: "add", task_text: "tarea C" }, undefined, undefined, ctx);
    } catch (e) {
      threw = true;
      assert.match(String(e), /stale/u, "si lanza, que sea el error de stale (no otro)");
    }
    assert.equal(threw, false, "persistState() debe degradar, no lanzar, con `pi` stale");
    assert.match(res.content[0].text, /Added task/u, "el tool devuelve el resultado normal");
  } finally {
    process.env.HOME = prevHome;
  }
});
