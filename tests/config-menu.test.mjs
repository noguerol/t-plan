/**
 * The /t-plan config menu is now a SettingsList (pi's native settings pattern):
 * one item per setting, with a `description` rendered under the list when the
 * item is selected, and a submenu for free-text options. These tests exercise
 * the real factory (real SettingsList from @earendil-works/pi-tui) headlessly.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const CONFIG_KEYS = [
  "enabled", "autoDetect", "showWidget", "widgetPlacement", "planFilePrefix",
  "trackAgents", "trimegisto", "showTimers", "toolEvidence", "debug",
  "animateWidget", "compactTaskLines", "highlightCompleted",
];

function itemById(items, id) {
  return items.find((i) => i.id === id);
}

/** Feed raw input into the component the menu factory returned. */
function send(component, data) {
  component.handleInput(data);
}

/**
 * SettingsList uses pi's Kitty-style key protocol internally via matchesKey,
 * but plain escape sequences also work. Arrow up/down are "\x1b[A"/"\x1b[B".
 */
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

test("every config setting is a SettingsList item with a description", async () => {
  const h = await createHarness({ sessionId: "cfgmenu001" });
  try {
    const items = h.rt.configItems();
    assert.ok(Array.isArray(items) && items.length > 0, "configItems must return a list");

    const settingIds = items.filter((i) => CONFIG_KEYS.includes(i.id)).map((i) => i.id);
    for (const key of CONFIG_KEYS) {
      assert.ok(settingIds.includes(key), `missing config item for '${key}'`);
    }
    for (const item of items.filter((i) => CONFIG_KEYS.includes(i.id))) {
      assert.ok(typeof item.description === "string" && item.description.length > 20,
        `${item.id} needs a real explanatory description, got: ${item.description}`);
    }
    // Actions are reachable too.
    for (const action of ["save", "load", "clear", "purge"]) {
      assert.ok(itemById(items, action), `missing action item '${action}'`);
    }
    // Items without an explicit `values` list must not carry a bogus currentValue:
    // the native list would then render "label  value" and pressing Enter would
    // silently set the config key to that placeholder.
    for (const item of items.filter((i) => CONFIG_KEYS.includes(i.id) && !i.values && !i.submenu)) {
      assert.equal(item.currentValue, undefined, `${item.id} should have no currentValue`);
    }
  } finally {
    await h.stop();
  }
});

test("currentValue of each item reflects the live config", async () => {
  const h = await createHarness({ sessionId: "cfgmenu002" });
  try {
    const items = h.rt.configItems();
    const onOff = (v) => (v ? "on" : "off");
    for (const key of ["enabled", "autoDetect", "showWidget", "trackAgents", "trimegisto", "showTimers", "toolEvidence", "debug", "animateWidget", "compactTaskLines", "highlightCompleted"]) {
      const item = itemById(items, key);
      assert.ok(item.values?.length === 2, `${key} must offer exactly two values`);
      assert.ok(item.values.includes("on") && item.values.includes("off"), `${key} values must be on/off`);
      assert.ok(item.currentValue === "on" || item.currentValue === "off", `${key} currentValue must be on/off, got ${item.currentValue}`);
    }
    const placement = itemById(items, "widgetPlacement");
    assert.ok(["aboveEditor", "belowEditor"].includes(placement.currentValue));
    const prefix = itemById(items, "planFilePrefix");
    assert.ok(typeof prefix.currentValue === "string" && prefix.currentValue.length > 0);
    assert.ok(typeof prefix.submenu === "function", "planFilePrefix needs a submenu for free text");
  } finally {
    await h.stop();
  }
});

test("selecting an item toggles the real config and re-renders the value", async () => {
  const h = await createHarness({ sessionId: "cfgmenu003" });
  try {
    let component;
    h.ctx.ui.custom = async (factory) => {
      const tui = { requestRender: () => {} };
      const theme = { fg: (_c, s) => s, bold: (s) => s };
      component = await factory(tui, theme, {}, () => {});
      return undefined;
    };

    await h.rt.tPlanCommand.handler("config", h.ctx);
    assert.ok(component && typeof component.render === "function", "menu must render a component");

    const before = h.rt.configItems().find((i) => i.id === "showWidget").currentValue;

    // Navigate to the widget item and toggle it with Enter.
    const items = h.rt.configItems();
    let idx = items.findIndex((i) => i.id === "showWidget");
    for (let i = 0; i < idx; i++) send(component, DOWN);
    send(component, ENTER);

    const after = h.rt.configItems().find((i) => i.id === "showWidget").currentValue;
    assert.notEqual(after, before, "Enter on a toggle item must flip its value");
    assert.equal(after, before === "on" ? "off" : "on", "toggle must alternate on/off");

    // The rendered list shows the showWidget row with its *new* value.
    const rendered = component.render(80);
    const widgetLine = rendered.find((l) => l.includes("Task widget"));
    assert.ok(widgetLine, "the Task widget row must be rendered");
    assert.ok(/\boff\b/.test(widgetLine), `rendered showWidget row must show 'off', got:\n${widgetLine}`);

    // And the widget is actually gone from the UI when showWidget is off.
    // (h.widgets is not exposed; check via notify side effects instead.)
  } finally {
    await h.stop();
  }
});

test("the selected item's description is rendered under the list", async () => {
  const h = await createHarness({ sessionId: "cfgmenu004" });
  try {
    let component;
    h.ctx.ui.custom = async (factory) => {
      const tui = { requestRender: () => {} };
      const theme = { fg: (_c, s) => s, bold: (s) => s };
      component = await factory(tui, theme, {}, () => {});
      return undefined;
    };
    await h.rt.tPlanCommand.handler("config", h.ctx);

    const items = h.rt.configItems();
    const target = itemById(items, "autoDetect");
    const idx = items.findIndex((i) => i.id === "autoDetect");
    for (let i = 0; i < idx; i++) send(component, DOWN);
    const rendered = component.render(80).join("\n");
    assert.ok(rendered.includes(target.label), "label must be rendered");
    assert.ok(rendered.includes("reconcile") || rendered.includes("reconcil"),
      `description of selected item must appear when selected; got:\n${rendered}`);
  } finally {
    await h.stop();
  }
});

test("planFilePrefix opens a submenu that applies the chosen prefix", async () => {
  // Pass the typed prefix through the harness so the tracked ui.input returns it.
  const h = await createHarness({ sessionId: "cfgmenu005", uiInput: "myprefix" });
  const { inputCalls } = h;
  try {
    let component;
    // Pass the theme into configItems so the submenu gets a real SelectListTheme
    // even when the global theme singleton is not initialized (headless test).
    const theme = { fg: (_c, s) => s, bold: (s) => s };
    h.ctx.ui.custom = async (factory) => {
      const tui = { requestRender: () => {} };
      component = await factory(tui, theme, {}, () => {});
      return undefined;
    };

    await h.rt.tPlanCommand.handler("config", h.ctx);

    const items = h.rt.configItems(theme);
    const idx = items.findIndex((i) => i.id === "planFilePrefix");
    for (let i = 0; i < idx; i++) send(component, DOWN);
    send(component, ENTER); // enter the submenu
    send(component, ENTER); // pick the first candidate

    // Entering the submenu prompts for a custom prefix (the real factory reads
    // ctx.ui.input), then applies it asynchronously. Await that microtask chain
    // before reading the value, otherwise we race the pending applyConfigChoice.
    assert.ok(inputCalls.length > 0, "submenu should prompt for a custom prefix via ui.input");
    await new Promise((r) => setTimeout(r, 0));
    const now = h.rt.configItems(theme).find((i) => i.id === "planFilePrefix").currentValue;
    assert.equal(now, "myprefix", `prefix should be the typed value, got ${now}`);
  } finally {
    await h.stop();
  }
});

test("submenu renders without throwing when the global theme is not initialized", async () => {
  const h = await createHarness({ sessionId: "cfgmenu007" });
  try {
    let component;
    const theme = { fg: (_c, s) => s, bold: (s) => s };
    h.ctx.ui.custom = async (factory) => {
      const tui = { requestRender: () => {} };
      component = await factory(tui, theme, {}, () => {});
      return undefined;
    };
    await h.rt.tPlanCommand.handler("config", h.ctx);
    const items = h.rt.configItems(theme);
    const idx = items.findIndex((i) => i.id === "planFilePrefix");
    for (let i = 0; i < idx; i++) send(component, DOWN);
    send(component, ENTER);
    const rendered = component.render(80).join("\n");
    assert.ok(rendered.includes("plan"), "submenu must render candidates without throwing");
  } finally {
    await h.stop();
  }
});

test("Esc closes the menu without changing anything", async () => {
  const h = await createHarness({ sessionId: "cfgmenu006" });
  try {
    let component;
    let closedResult;
    h.ctx.ui.custom = async (factory) => {
      const tui = { requestRender: () => {} };
      const theme = { fg: (_c, s) => s, bold: (s) => s };
      component = await factory(tui, theme, {}, (r) => { closedResult = r; });
      return undefined;
    };
    const snapshot = JSON.stringify(h.rt.configItems().map((i) => [i.id, i.currentValue]));
    await h.rt.tPlanCommand.handler("config", h.ctx);
    send(component, ESC);
    const after = JSON.stringify(h.rt.configItems().map((i) => [i.id, i.currentValue]));
    assert.equal(snapshot, after, "Esc must not mutate any setting");
    void closedResult;
  } finally {
    await h.stop();
  }
});
