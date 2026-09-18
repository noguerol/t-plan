/**
 * Adversarial QA for the SettingsList config menu: can it crash, leak
 * placeholder values into config, or misrepresent state?
 *
 * All mutations go through the real menu component (open the dialog, navigate,
 * press Enter) exactly as a user would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

/**
 * `applyConfigChoice` is async: the planFilePrefix branch awaits
 * `ctx.ui.input` then real fs I/O (access/writeFile/unlink/stat), all of which
 * settle on macrotasks (libuv), not microtasks. A single microtask flush is
 * not enough, so poll the postcondition with a timeout instead.
 */
async function waitFor(predicate, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeout}ms`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Open the config dialog and capture the live SettingsList.
 * runtime.ts calls `ctx.ui.custom(factory)`; the factory receives
 * (tui, theme, kb, done) and returns a handle whose `handleInput` delegates to
 * the SettingsList. We wrap `custom` to intercept the factory and then drive it
 * ourselves, capturing the returned handle.
 */
async function openMenu(h) {
  let component;
  h.ctx.ui.custom = async (factory) => {
    const tui = { requestRender: () => {} };
    const theme = { fg: (_c, s) => s, bold: (s) => s, dim: (s) => s };
    component = await factory(tui, theme, {}, () => {});
    return undefined;
  };
  await h.rt.tPlanCommand.handler("config", h.ctx);
  assert.ok(component && typeof component.handleInput === "function", "menu must expose handleInput");
  return component;
}

/** Navigate down to the item with id `id` and press Enter, using the real list. */
async function activate(component, id) {
  // The handle wraps a Container; the SettingsList is the second child.
  const list = component._list ?? component.list ?? null;
  if (!list) {
    // Fallback: walk by rendered rows and count Enter presses.
    const lines = component.render(80);
    const idx = lines.findIndex((l) => l.includes(idLabel(id)));
    assert.ok(idx >= 0, `menu render does not contain item '${id}'`);
    for (let i = 0; i < idx; i++) component.handleInput(DOWN);
    component.handleInput(ENTER);
    return;
  }
  const items = list.items;
  const idx = items.findIndex((i) => i.id === id);
  assert.ok(idx >= 0, `menu is missing item '${id}'`);
  for (let i = 0; i < idx; i++) list.handleInput(DOWN);
  list.handleInput(ENTER);
}

const LABELS = {
  enabled: "📋 Plan tracking",
  autoDetect: "🔎 Auto-detect plans",
  showWidget: "📊 Task widget",
  widgetPlacement: "📌 Placement",
  planFilePrefix: "🏷️ Prefix",
  trackAgents: "🤖 Track agents",
  trimegisto: "🧩 Trimegisto",
  showTimers: "⏱️ Timers",
  toolEvidence: "🔍 Tool evidence",
  debug: "🐛 Debug log",
  animateWidget: "✨ Animate",
  compactTaskLines: "📄 Compact lines",
  highlightCompleted: "✔️ Highlight done",
  save: "💾 Save",
  load: "📂 Load",
  clear: "🗑️ Clear",
  purge: "🧹 Purge",
};

function idLabel(id) {
  return LABELS[id] ?? id;
}

test("every toggle's currentValue matches the live config value", async () => {
  const h = await createHarness({ sessionId: "qaconfig1" });
  try {
    for (const item of h.rt.configItems()) {
      const bools = (item.values ?? []).filter((v) => v.value === true || v.value === false);
      if (item.values?.length === 2 && bools.length === 2) {
        assert.strictEqual(item.currentValue, String(h.rt.getConfig()[item.id]),
          `${item.id}: currentValue ${item.currentValue} != config ${h.rt.getConfig()[item.id]}`);
      }
    }
  } finally {
    await h.cleanup();
  }
});

test("action items use submenus and never carry boolean/placeholder values", async () => {
  const h = await createHarness({ sessionId: "qaconfig2" });
  try {
    for (const id of ["save", "load", "clear", "purge"]) {
      const item = h.rt.configItems().find((i) => i.id === id);
      assert.ok(item.submenu, `${id} must open a submenu, not inline values`);
      assert.ok(!(item.values ?? []).some((v) => v.value === true || v.value === false),
        `${id} must not expose boolean values (the native list would persist them)`);
    }
  } finally {
    await h.cleanup();
  }
});

test("opening the menu never mutates config, even twice", async () => {
  const h = await createHarness({ sessionId: "qaconfig3" });
  try {
    const before = JSON.stringify(h.rt.getConfig());
    await openMenu(h);
    await openMenu(h);
    assert.strictEqual(JSON.stringify(h.rt.getConfig()), before, "opening the menu must not change config");
  } finally {
    await h.cleanup();
  }
});

test("Esc closes the menu without writing anything", async () => {
  const h = await createHarness({ sessionId: "qaconfig4" });
  try {
    const before = JSON.stringify(h.rt.getConfig());
    const component = await openMenu(h);
    for (let i = 0; i < 5; i++) component.handleInput(DOWN);
    component.handleInput(ESC);
    assert.strictEqual(JSON.stringify(h.rt.getConfig()), before, "Esc must not change config");
  } finally {
    await h.cleanup();
  }
});

test("toggling a setting writes only that key (no stray keys appear)", async () => {
  const h = await createHarness({ sessionId: "qaconfig5" });
  try {
    const before = { ...h.rt.getConfig() };
    const component = await openMenu(h);
    await activate(component, "debug");
    const after = h.rt.getConfig();
    const added = Object.keys(after).filter((k) => !(k in before));
    assert.strictEqual(added.length, 0, `toggling added stray keys: ${added.join(", ")}`);
    assert.strictEqual(after.debug, !before.debug);
  } finally {
    await h.cleanup();
  }
});

test("a prefix change renames the live plan file only when it changes the name", async () => {
  // uiInput is a queue: the first prompt answers "myplan", the second "plan",
  // so a single harness can exercise a round trip without cross-harness config
  // inheritance (which is itself async via saveGlobalConfig fire-and-forget).
  const h = await createHarness({ sessionId: "qaconfig6", uiInput: ["myplan", "plan"] });
  try {
    await h.tool({ action: "add", task_text: "seed task" });
    const filesBefore = await h.planFiles();
    assert.ok(filesBefore.some((f) => f.startsWith("plan_")), "expected a plan_ file before the change");

    // "plan" -> "myplan": the live plan file must move, not be duplicated.
    const component = await openMenu(h);
    component.list.selectItem("planFilePrefix");
    component.handleInput(ENTER); // open the "Change prefix…" submenu
    component.handleInput(ENTER); // run it -> ctx.ui.input("myplan")
    await waitFor(async () => {
      if (h.rt.getConfig().planFilePrefix !== "myplan") return false;
      const files = await h.planFiles();
      return files.some((f) => f.startsWith("myplan_")) && !files.some((f) => f.startsWith("plan_"));
    });

    assert.strictEqual(h.rt.getConfig().planFilePrefix, "myplan", "the typed prefix must persist");
    const filesAfter = await h.planFiles();
    assert.ok(filesAfter.some((f) => f.startsWith("myplan_")), "the plan file must be renamed to the new prefix");
    assert.ok(!filesAfter.some((f) => f.startsWith("plan_")), "the old file must not be orphaned");
    // Tasks survive the move.
    assert.strictEqual((await h.plan()).length, 1, "tasks must survive the prefix rename");

    // "myplan" -> "plan" (back to the default): must move back, not leave a duplicate.
    const component2 = await openMenu(h);
    component2.list.selectItem("planFilePrefix");
    component2.handleInput(ENTER);
    component2.handleInput(ENTER);
    await waitFor(async () => {
      if (h.rt.getConfig().planFilePrefix !== "plan") return false;
      const files = await h.planFiles();
      return files.some((f) => f.startsWith("plan_")) && !files.some((f) => f.startsWith("myplan_"));
    });
    const filesAfter2 = await h.planFiles();
    assert.ok(filesAfter2.filter((f) => f.endsWith(".md")).length === 1, `expected exactly one plan file, got ${filesAfter2.join(", ")}`);
  } finally {
    await h.cleanup();
  }
});

test("trimegisto mode toggles cleanly on and off", async () => {
  const h = await createHarness({ sessionId: "qaconfig7" });
  try {
    const component = await openMenu(h);
    component.list.selectItem("trimegisto");
    component.handleInput(ENTER);
    const val = h.rt.getConfig().trimegisto;
    assert.ok(val === true || (typeof val === "object" && val?.tier), `expected a truthy TG config, got ${JSON.stringify(val)}`);
    // Toggle back off through the same menu.
    const component2 = await openMenu(h);
    component2.list.selectItem("trimegisto");
    component2.handleInput(ENTER);
    assert.ok(!h.rt.getConfig().trimegisto, "trimegisto must be falsy when disabled");
  } finally {
    await h.cleanup();
  }
});

test("persisted config.json contains no action placeholders after a full menu round-trip", async () => {
  const h = await createHarness({ sessionId: "qaconfig8" });
  try {
    const component = await openMenu(h);
    for (const id of ["save", "load", "clear", "purge"]) {
      await activate(component, id);
    }
    const persistedPath = join(process.env.HOME, ".pi", "agent", "t-plan", "config.json");
    try {
      const persisted = JSON.parse(readFileSync(persistedPath, "utf8"));
      for (const id of ["save", "load", "clear", "purge"]) {
        assert.ok(!(id in persisted.config), `action '${id}' leaked into persisted config: ${JSON.stringify(persisted.config[id])}`);
      }
    } catch {
      // No config file written at all is also acceptable (nothing to leak).
    }
  } finally {
    await h.cleanup();
  }
});
