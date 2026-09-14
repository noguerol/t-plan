// Adversarial edge-case QA of the injected model context (onBeforeAgentStart)
// and of the plan_manager tool error paths.
//
// Owns ONLY this file. It never modifies src/ or any other test. Every runtime
// test uses the shared harness (tests/helpers/harness.mjs) with a temp HOME and a
// temp cwd, so no real project file or user config is ever read or written.
//
// One test per hypothesis (1)-(6). A failure is kept as evidence; the minimal
// fix is stated in the assertion message (src/ is never edited from here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

/** Injected [PLAN] context of a run, or "" when nothing was returned. */
const injected = (res) => res?.message?.content ?? "";

// ── (1) zero tasks → no injected context, no throw ────────────────────────────
test("(1) zero tasks: onBeforeAgentStart returns undefined and does not throw", async () => {
  const h = await createHarness({ sessionId: "ctxedge001" });
  try {
    assert.equal((await h.plan()).length, 0, "sanity: the fresh plan must start empty");

    let res;
    await assert.doesNotReject(async () => {
      res = await h.runStart();
    }, "onBeforeAgentStart must not throw with zero tasks");

    assert.equal(
      res,
      undefined,
      `zero tasks must inject NO context (got ${JSON.stringify(res)}) ` +
        `→ minimal fix: keep the early \`if (state.tasks.length > 0)\` guard in onBeforeAgentStart.`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (2) > 40 pending → cap at 40 + "+N more" note ─────────────────────────────
test("(2) >40 pending: context lists up to the 40-task cap and notes '+N more'", async () => {
  const h = await createHarness({ sessionId: "ctxedge002" });
  try {
    await h.addTasks(Array.from({ length: 45 }, (_, i) => `pending alpha ${i + 1}`));

    const c = injected(await h.runStart());
    assert.ok(c.includes("Todo:"), "missing 'Todo:' group header for pending tasks");

    // The last task inside the cap must be listed...
    assert.ok(/^- ⏳ #40\./m.test(c), `pending #40 must be listed, got context:\n${c}`);
    // ...and nothing beyond it (refs are 1..#45).
    assert.ok(!/^- ⏳ #41\./m.test(c), "pending #41 must be cut off by the 40-task cap");

    assert.match(
      c,
      /\+5 more/,
      `45 pending with a 40 cap must end with '+5 more', got context:\n${c} ` +
        "→ minimal fix: keep the `+${pending.length - PENDING_CAP} more (plan_manager list)` note."
    );

    // The note must CLOSE the Todo list (40 task bullets + the note), not appear mid-list.
    const todoSection = c.slice(c.indexOf("Todo:"), c.indexOf("Rules:"));
    const todoBullets = todoSection.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(todoBullets.length, 41, `Todo must hold 40 bullets + the note, got ${todoBullets.length}:\n${todoSection}`);
    assert.match(
      todoBullets.at(-1),
      /^- … \+5 more \(plan_manager list\)$/,
      `the Todo list must END with the '+N more' note, got last bullet: ${todoBullets.at(-1)}`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (3) mixed statuses → Doing / Blocked / Done markers + refs ────────────────
test("(3) mixed in_progress/blocked/done: Doing/Blocked/Done markers carry their refs", async () => {
  const h = await createHarness({ sessionId: "ctxedge003" });
  try {
    await h.addTasks(["doing edge", "blocked edge", "done edge", "still pending"]);
    await h.tool({ action: "start", task_id: "1" });
    await h.tool({ action: "block", task_id: "2" });
    await h.tool({ action: "complete", task_id: "3" });

    const c = injected(await h.runStart());

    assert.ok(c.includes("Doing:"), "missing 'Doing:' header for the in_progress task");
    assert.match(c, /Doing:\n- 🔄 #1\./, "Doing group must carry ref #1");
    assert.ok(c.includes("Blocked:"), "missing 'Blocked:' header for the blocked task");
    assert.match(c, /Blocked:[^\n]*#2\b/, "Blocked group must carry ref #2");
    assert.match(c, /Done \(\d+\):[^\n]*#3\b/, "Done group must carry ref #3");
  } finally {
    await h.cleanup();
  }
});

// ── (4) TG enabled + tiers unavailable → [TG] block still renders ─────────────
test("(4) TG enabled with no tiers: [TG] block renders 'available:' and context is non-empty", async () => {
  const h = await createHarness({ sessionId: "ctxedge004" });
  try {
    await h.addTasks(["tg edge anchor"]);
    // Enable TG through the real config menu (tiers are unavailable because the
    // temp HOME has no ~/.pi/agent/trimegisto/config.json).
    h.ctx.ui.select = async () => "❌ TG: OFF";
    await h.rt.tPlanCommand.handler("config", h.ctx);

    const c = injected(await h.runStart());
    assert.ok(c.length > 0, "TG-enabled context must be non-empty");
    assert.ok(c.includes("[PLAN]"), "TG-enabled context must still carry [PLAN]");
    assert.ok(c.includes("[TG]"), "TG-enabled context must inject a [TG] block");

    const tg = c.slice(c.indexOf("[TG]"));
    const available = tg.split("\n").find((l) => l.startsWith("available:"));
    assert.ok(available, `[TG] block must render an 'available:' line, got:\n${c}`);
    assert.equal(
      available.trim(),
      "available: active",
      `unavailable tiers must fall back to active only, got: ${available} ` +
        `→ minimal fix: keep isTierAvailable() returning only 'active'/t0 when no tier config exists.`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (5) 2000-char text + unicode/emoji do not break context ───────────────────
test("(5) 2000-char task text + unicode/emoji survive context generation", async () => {
  const h = await createHarness({ sessionId: "ctxedge005" });
  try {
    const long = "T".repeat(1990) + "🤖🌟漢字é"; // ≈2000 code units, mixed scripts
    await h.addTasks([long, "emoji only 🚀🔥✅"]);

    let res;
    await assert.doesNotReject(async () => {
      res = await h.runStart();
    }, "long/unicode task text must not break onBeforeAgentStart");

    const c = injected(res);
    assert.ok(c.includes("[PLAN]"), "long/unicode text must still yield a [PLAN] context");
    assert.ok(c.includes("🚀🔥✅"), "emoji-only task text must reach the injected context");
    assert.ok(
      c.includes(long),
      "the 2000-char task text must reach the injected context verbatim " +
        "→ minimal fix: never slice/escape t.text in onBeforeAgentStart's task lines."
    );
  } finally {
    await h.cleanup();
  }
});

// ── (6) tool error paths → ref list, never a throw ────────────────────────────
test("(6) empty/undefined task_id returns refs without throwing; unknown remove says 'Task not found'", async () => {
  const h = await createHarness({ sessionId: "ctxedge006" });
  try {
    await h.addTasks(["alpha edge", "beta edge"]);

    const call = async (action, task_id) => {
      const params = { action };
      if (task_id !== undefined) params.task_id = task_id;
      return (await h.tool(params)).content[0].text;
    };

    for (const action of ["complete", "start", "block", "update", "remove"]) {
      for (const task_id of ["", "   ", undefined]) {
        // A throw here would fail the test naturally (the tool must return, not reject).
        const text = await call(action, task_id);
        const id = task_id === undefined ? "<undefined>" : JSON.stringify(task_id);
        assert.match(
          text,
          /task_id required/,
          `${action} with task_id=${id} must report a missing task_id, got: ${text}`
        );
        assert.match(text, /Refs:\n/, `${action} with task_id=${id} must include the ref list`);
        assert.ok(
          /#1\b/.test(text) && /#2\b/.test(text),
          `${action} with task_id=${id} must list the existing refs #1/#2, got: ${text}`
        );
      }
    }

    const unknown = "definitely-not-a-task-zzz";
    const notFound = await call("remove", unknown);
    assert.match(
      notFound,
      new RegExp(`^Task not found: ${unknown}`),
      `remove of an unknown text must return 'Task not found: <text>', got: ${notFound} ` +
        `→ minimal fix: keep the \`targets.length === 0\` branch in the remove case.`
    );
  } finally {
    await h.cleanup();
  }
});
