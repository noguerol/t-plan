import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./helpers/harness.mjs";

/**
 * `/t-plan edit` fullscreen edit mode.
 *
 * The interactive loop drains `ctx.ui.custom.editCommands` and applies each
 * command through the same code path the editor's onSubmit would. We drive it
 * headlessly by injecting commands and asserting on the resulting plan state.
 */
async function withPlan(fn) {
  const h = await createHarness({
    uiInput: "", // input() returns "" by default (cancel/no-op)
  });
  await h.rt.tPlanCommand.handler("new", h.ctx);
  await h.addTasks(["Write tests", "Add docs", "Ship it"]);
  await h.rt.tPlanCommand.handler("edit", h.ctx);
  await fn(h);
  await h.cleanup();
}

test("edit mode: /del removes the selected task", async () => {
  await withPlan(async (h) => {
    assert.equal((await h.plan()).length, 3);
    h.editCommands.push("/del", "/cancel");
    await h.rt.tPlanCommand.handler("edit", h.ctx);
    const plan = await h.plan();
    assert.equal(plan.length, 2);
    assert.deepEqual(plan.map((t) => t.ref), [1, 2]);
  });
});

test("edit mode: /up and /down reorder tasks", async () => {
  await withPlan(async (h) => {
    // task #3 (order 3) -> up twice => becomes first.
    h.editCommands.push("/up", "/up", "/cancel");
    await h.rt.tPlanCommand.handler("edit", h.ctx);
    const plan = await h.plan();
    assert.equal(plan[0].ref, 3);
    assert.deepEqual(plan.map((t) => t.ref), [3, 1, 2]);
  });
});

test("edit mode: /add appends a new task", async () => {
  await withPlan(async (h) => {
    h.editCommands.push("/add release notes", "/cancel");
    await h.rt.tPlanCommand.handler("edit", h.ctx);
    const plan = await h.plan();
    assert.equal(plan.length, 4);
    assert.equal(plan[plan.length - 1].ref, 4);
    assert.match(plan[plan.length - 1].text, /release notes/);
  });
});

test("edit mode: /edit rewrites the selected task text", async () => {
  await withPlan(async (h) => {
    h.uiInput = "Renamed task";
    h.editCommands.push("/edit", "/cancel");
    await h.rt.tPlanCommand.handler("edit", h.ctx);
    const plan = await h.plan();
    assert.equal(plan[0].text, "Renamed task");
  });
});

test("edit mode: /note attaches notes to the selected task", async () => {
  await withPlan(async (h) => {
    h.uiInput = "Needs a changelog entry";
    h.editCommands.push("/note", "/cancel");
    await h.rt.tPlanCommand.handler("edit", h.ctx);
    const state = h.rt.getState();
    const task = state.tasks.find((t) => t.ref === 1);
    assert.equal(task.notes, "Needs a changelog entry");
  });
});

test("edit mode: /run aborts current run and sends a launch message", async () => {
  await withPlan(async (h) => {
    h.editCommands.push("/run", "/cancel");
    await h.rt.tPlanCommand.handler("edit", h.ctx);
    assert.equal(h.abortCalls.length, 1, "abort should be called to stop current run");
    assert.match(h.sendUserMessageCalls[0], /^\/t-run 1/);
  });
});

test("edit mode: empty plan still opens and can add", async () => {
  const h = await createHarness({ uiInput: "" });
  await h.rt.tPlanCommand.handler("new", h.ctx);
  h.editCommands.push("/add first task", "/cancel");
  await h.rt.tPlanCommand.handler("edit", h.ctx);
  const plan = await h.plan();
  assert.equal(plan.length, 1);
  await h.cleanup();
});
