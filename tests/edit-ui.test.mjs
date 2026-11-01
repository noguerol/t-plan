import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const tui = await import("@earendil-works/pi-tui");
// The interactive path builds real SelectList/Text/Editor components. Only the
// real package exposes setSelectedIndex; the bare test stub cannot run it.
const hasRealTui = typeof tui.SelectList?.prototype?.setSelectedIndex === "function";

const fakeTui = {
  mode: "regular",
  terminal: { columns: 100 },
  requestRender() {},
  renderNow() {},
};

const fakeTheme = {
  fg: (_token, text) => text,
  bg: (_token, text) => text,
  bold: (text) => text,
  dim: (text) => text,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await sleep(10);
  }
  return false;
}

async function openInteractiveEdit(h) {
  let component;
  let closed = false;
  h.ctx.ui.custom = async (factory) => {
    component = await factory(fakeTui, fakeTheme, {}, () => { closed = true; });
    return component;
  };
  await h.rt.tPlanCommand.handler("edit", h.ctx);
  return { component, isClosed: () => closed };
}

test("interactive edit mode renders the task list with the real pi-tui API", { skip: !hasRealTui }, async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera tarea", "Segunda tarea", "Tercera tarea"]);
    const { component } = await openInteractiveEdit(h);

    const screen = component.render(100).join("\n");
    assert.match(screen, /#1\. Primera tarea/, screen);
    assert.match(screen, /#2\. Segunda tarea/, screen);
    assert.match(screen, /#3\. Tercera tarea/, screen);
    assert.match(screen, /edit mode/, "the header must be rendered");
    assert.match(screen, /Status: pending/, "the detail pane must render the selected task");
  } finally {
    await h.cleanup();
  }
});

test("interactive edit mode: arrows move the selection and /del removes that task", { skip: !hasRealTui }, async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera tarea", "Segunda tarea", "Tercera tarea"]);
    const { component } = await openInteractiveEdit(h);

    // Default selection is the last task (#3); up once selects #2.
    component.handleInput("\x1b[A");
    await sleep(10);

    for (const ch of "/del") component.handleInput(ch);
    component.handleInput("\r");

    assert.ok(
      await waitFor(() => h.rt.getState().tasks.length === 2),
      `the task under the cursor must be deleted: ${JSON.stringify(h.rt.getState().tasks.map((t) => t.ref))}`
    );
    assert.deepEqual(h.rt.getState().tasks.map((t) => t.ref), [1, 3], "the selected task (#2) was removed");
  } finally {
    await h.cleanup();
  }
});

test("interactive edit mode: Enter on the list edits inline without replacing the fullscreen UI", { skip: !hasRealTui }, async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera tarea", "Segunda tarea"]);
    const { component } = await openInteractiveEdit(h);

    // Empty command line + Enter on the selected task (the last one, #2)
    // switches to inline text mode with the task text prefilled.
    component.handleInput("\r");
    await sleep(10);

    // The selected task is the last one (#2). Replace its text and submit.
    for (let i = 0; i < 40; i++) component.handleInput("\x7f"); // backspace ×40
    for (const ch of "Renombrada") component.handleInput(ch);
    component.handleInput("\r");

    assert.ok(await waitFor(() => h.rt.getState().tasks.some((t) => t.text === "Renombrada")));
    assert.equal(h.rt.getState().tasks.find((t) => t.ref === 2).text, "Renombrada");
  } finally {
    await h.cleanup();
  }
});

test("interactive edit mode: /edit <text> renames the selected task", { skip: !hasRealTui }, async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera tarea", "Segunda tarea"]);
    const { component } = await openInteractiveEdit(h);

    // Selection is the last task (#2).
    for (const ch of "/edit Renombrada asi") component.handleInput(ch);
    component.handleInput("\r");

    assert.ok(await waitFor(() => h.rt.getState().tasks.some((t) => t.text === "Renombrada asi")));
  } finally {
    await h.cleanup();
  }
});

test("interactive edit mode: Esc closes the editor", { skip: !hasRealTui }, async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["Primera tarea"]);
    const { component, isClosed } = await openInteractiveEdit(h);
    component.handleInput("\x1b");
    assert.equal(isClosed(), true, "Esc must resolve the custom UI");
  } finally {
    await h.cleanup();
  }
});
