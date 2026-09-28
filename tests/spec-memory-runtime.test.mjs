/**
 * Integration coverage for the spec-driven project memory (v1.7).
 *
 * Exercises the real runtime through the shared harness: a structured prompt is
 * detected, decomposed into requirements, auto-seeded as lane tasks, injected as
 * a [SPEC] block, persisted to the plan file and re-adopted by a later session.
 * It also proves the two gates: a spec task cannot be completed unverified, and
 * the model cannot declare the project finished while coverage is incomplete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const SPEC = `# Checkout Service Specification

## Authentication
- The system MUST authenticate users via OAuth2 with refresh tokens.
- Must persist user sessions in Postgres for 30 days.
- Must lock the account after five failed login attempts.

## Payments
- The API MUST expose POST /payments validating the amount and currency.
- Must support idempotency keys for every payment request.
- Must refund a captured payment within 10 seconds.

## Observability
- The service MUST emit structured logs for every request.
- Must expose GET /health returning database connectivity.
- Must alert when the payment error rate exceeds 1%.`;

const assistantMsg = (text, stopReason = "stop") => ({
  type: "turn_end",
  turnIndex: 1,
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, usage: {} },
  toolResults: [],
});

async function seed(h) {
  return h.rt.onBeforeAgentStart({ prompt: SPEC, systemPrompt: "" }, h.ctx);
}

async function seedOne(h, prompt) {
  return h.rt.onBeforeAgentStart({ prompt, systemPrompt: "" }, h.ctx);
}

test("structured prompt is detected, decomposed and seeded into lanes", async () => {
  const h = await createHarness({ sessionId: "specmem001" });
  try {
    await seed(h);

    const state = h.rt.getState();
    assert.equal(state.specs?.length, 1, "prompt spec source must be registered");
    assert.ok((state.requirements?.length ?? 0) >= 8, `expected >= 8 requirements, got ${state.requirements?.length}`);

    // F-4: requirements are the ledger; only the active window becomes tasks.
    const active = state.tasks.filter((t) => (t.lane ?? "active") === "active");
    assert.equal(active.length, 5, "the active lane is capped at SPEC_ACTIVE_WINDOW (5)");
    assert.equal(state.tasks.length, 5, "only the active window is tasked; the rest stays in the ledger");
    const mappedIds = new Set(state.tasks.flatMap((t) => t.reqs ?? []));
    assert.ok(
      state.requirements.filter((r) => !mappedIds.has(r.id)).length > 0,
      "requirements beyond the window must not be turned into tasks"
    );
    assert.ok(state.tasks.every((t) => (t.reqs?.length ?? 0) === 1), "every seeded task traces to a requirement");
    assert.ok(state.tasks.every((t) => typeof t.spec === "string" && t.spec.length > 0), "every seeded task carries its spec excerpt");
    assert.ok(state.tasks.every((t) => (t.check?.length ?? 0) > 0), "every seeded task carries acceptance checks");
    assert.ok(state.tasks.every((t) => t.text.length <= 80), "task titles are derived, never the raw requirement line");
  } finally {
    await h.cleanup();
  }
});

test("injected context exposes [SPEC] coverage, the backlog and the gate", async () => {
  const h = await createHarness({ sessionId: "specmem002" });
  try {
    await seed(h);
    const res = await h.rt.onBeforeAgentStart({ prompt: "go", systemPrompt: "" }, h.ctx);
    const c = res?.message?.content ?? "";
    assert.ok(c.includes("[SPEC]"), "missing [SPEC] coverage block");
    assert.ok(/coverage: \d+\/\d+ satisfied/.test(c), `missing coverage line: ${c}`);
    assert.ok(c.includes("gaps:"), "missing coverage gaps (untasked requirements) line");
    assert.ok(c.includes("Gate: do NOT conclude"), "missing gate line while coverage < 100%");
    assert.ok(c.includes("[PLAN]"), "the base [PLAN] contract must survive");
    assert.ok(c.includes("Rules:"), "the Rules contract must survive");
  } finally {
    await h.cleanup();
  }
});

test("spec task cannot complete until verified; verify unlocks complete", async () => {
  const h = await createHarness({ sessionId: "specmem003" });
  try {
    await seed(h);
    const first = h.rt.getState().tasks[0];

    const refused = await h.tool({ action: "complete", task_id: String(first.ref) });
    assert.match(refused.content[0].text, /Not verified/i, `complete must be refused unverified: ${refused.content[0].text}`);
    assert.equal(h.rt.getState().tasks[0].status, "pending", "unverified task must stay pending");

    const verified = await h.tool({ action: "verify", task_id: String(first.ref), notes: "npm test → 32 passed" });
    assert.match(verified.content[0].text, /verified/i);
    assert.ok(h.rt.getState().tasks[0].verifiedAt > 0, "verifiedAt must be recorded");

    const done = await h.tool({ action: "complete", task_id: String(first.ref) });
    assert.match(done.content[0].text, /✓/, `verified task must complete: ${done.content[0].text}`);
    assert.equal(h.rt.getState().tasks[0].status, "done");
  } finally {
    await h.cleanup();
  }
});

test("premature conclusion is blocked and forces one continuation", async () => {
  const h = await createHarness({ sessionId: "specmem004" });
  try {
    await seed(h);
    assert.ok(h.rt.getState().requirements.length > 0);

    const res = await h.rt.onTurnEnd(
      assistantMsg("All done! Everything is complete and finished. Ready to ship."),
      h.ctx
    );
    assert.ok(res && res.continue === true, "the review gate must request a continuation");
    assert.equal(res.entries?.[0]?.customType, "plan-gap");
    assert.match(res.entries[0].content, /PLAN GATE/);
    // The plan must not have been wiped by the conclusion path.
    assert.ok(h.rt.getState().tasks.filter((t) => t.status !== "done").length > 0);
  } finally {
    await h.cleanup();
  }
});

test("plan file persists specs/requirements/lanes and a new session re-adopts them", async () => {
  const h = await createHarness({ sessionId: "specmem005" });
  try {
    await seed(h);
    const content = await h.planFile();
    assert.ok(content.includes("## 📋 Specs"), `plan file must carry the Specs section:\n${content}`);
    assert.ok(content.includes("## 🎯 Requirements"), "plan file must carry the Requirements section");
    assert.ok(/\(reqs:R\d+/.test(content), "task lines must carry the reqs marker");
    assert.ok(/^- \[ \] R\d+\./m.test(content), "untasked requirements stay enumerated in the ledger");

    const nReqs = h.rt.getState().requirements.length;

    // A brand-new session over the same project (same cwd) must rebuild the memory.
    const h2 = await createHarness({ sessionId: "specmem006", cwd: h.cwd });
    try {
      const s2 = h2.rt.getState();
      assert.equal(s2.specs?.length, 1, "specs must be re-adopted from the plan file");
      assert.equal(s2.requirements?.length, nReqs, "requirements must be re-adopted");
      assert.ok(s2.requirements.length >= s2.tasks.length, "the ledger survives with the tasked window");
    } finally {
      await h2.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test("coverage action reports mapped/satisfied and the unsatisfied list", async () => {
  const h = await createHarness({ sessionId: "specmem007" });
  try {
    await seed(h);
    const res = await h.tool({ action: "coverage" });
    assert.match(res.content[0].text, /\d+\/\d+ satisfied/);
    assert.match(res.content[0].text, /Unsatisfied:/);
    assert.ok(res.details.coverage.total >= 8);
    assert.equal(res.details.coverage.satisfied, 0);
  } finally {
    await h.cleanup();
  }
});

test("plan bulk-adds tasks and source ingests a referenced file", async () => {
  const h = await createHarness({ sessionId: "specmem009" });
  try {
    const res = await h.tool({
      action: "plan",
      task_text: "[R1] Implement OAuth\nR2: Expose /login\n- Wire the UI",
      lane: "backlog",
      check: "compiles | tests pass",
    });
    assert.match(res.content[0].text, /\+3 tasks/);
    const tasks = h.rt.getState().tasks;
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((t) => t.lane === "backlog"));
    assert.deepEqual(tasks[0].reqs, ["R1"]);
    assert.deepEqual(tasks[1].reqs, ["R2"]);
    assert.deepEqual(tasks[2].check, ["compiles", "tests pass"]);

    await writeFile(join(h.cwd, "more-spec.md"), "# More\n## Extra\n- Must export a health endpoint for the load balancer.\n", "utf-8");
    const src = await h.tool({ action: "source", task_text: "more-spec.md" });
    assert.match(src.content[0].text, /\+1 requirements/);
    assert.equal(h.rt.getState().specs.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("completing an active task promotes the next ledger requirement", async () => {
  const h = await createHarness({ sessionId: "specmem010" });
  try {
    await seed(h);
    const before = h.rt.getState().tasks.length;
    const active = h.rt.getState().tasks.find((t) => (t.lane ?? "active") === "active");
    await h.tool({ action: "verify", task_id: String(active.ref), notes: "npm test ok" });
    await h.tool({ action: "complete", task_id: String(active.ref) });
    const state = h.rt.getState();
    assert.equal(state.tasks.length, before + 1, "one ledger requirement must be promoted into a task");
    assert.equal(
      state.tasks.filter((t) => (t.lane ?? "active") === "active" && t.status !== "done").length,
      5,
      "the active lane stays full"
    );
  } finally {
    await h.cleanup();
  }
});

test("a removed spec task is re-seeded so coverage stays complete", async () => {
  const h = await createHarness({ sessionId: "specmem011" });
  try {
    await seed(h);
    const first = h.rt.getState().tasks[0];
    const reqId = first.reqs[0];
    await h.tool({ action: "remove", task_id: String(first.ref) });
    assert.ok(!h.rt.getState().tasks.some((t) => (t.reqs ?? []).includes(reqId)), "task must be gone");
    await h.rt.onTurnEnd(assistantMsg("ok"), h.ctx);
    assert.ok(
      h.rt.getState().tasks.some((t) => (t.reqs ?? []).includes(reqId)),
      "the requirement must be re-seeded so nothing is silently lost"
    );
  } finally {
    await h.cleanup();
  }
});

test("turning Spec memory off stops ingestion", async () => {
  const h = await createHarness({ sessionId: "specmem012" });
  try {
    h.rt.getConfig().specMemory = false;
    await seed(h);
    assert.equal(h.rt.getState().specs, undefined, "no spec source must be registered");
    assert.equal(h.rt.getState().tasks.length, 0, "no tasks must be seeded");
  } finally {
    await h.cleanup();
  }
});

test("the review gate is bounded and never drops spec tasks across conclusions", async () => {
  const h = await createHarness({ sessionId: "specmem013" });
  try {
    await seed(h);
    const before = h.rt.getState().tasks.length;
    const r1 = await h.rt.onTurnEnd(assistantMsg("All done, everything is complete."), h.ctx);
    assert.equal(r1?.continue, true, "first premature conclusion must force a continuation");
    const r2 = await h.rt.onTurnEnd(assistantMsg("All done, everything is complete."), h.ctx);
    assert.equal(r2?.continue, true, "second one still under the cap");
    const r3 = await h.rt.onTurnEnd(assistantMsg("All done, everything is complete."), h.ctx);
    assert.ok(!r3 || r3.continue !== true, "the gate must stop forcing after the cap");
    const state = h.rt.getState();
    assert.equal(state.tasks.length, before, "no task may be dropped (or added) by the blocked conclusion");
  } finally {
    await h.cleanup();
  }
});

test("an event already continuing is not forced again", async () => {
  const h = await createHarness({ sessionId: "specmem015" });
  try {
    await seed(h);
    const res = await h.rt.onTurnEnd(
      { ...assistantMsg("All done, everything is complete."), continue: true },
      h.ctx
    );
    assert.ok(!res || res.continue !== true, "must not loop when the boundary already continues");
  } finally {
    await h.cleanup();
  }
});

test("with the review gate off a spec task completes without verify", async () => {
  const h = await createHarness({ sessionId: "specmem014" });
  try {
    await seed(h);
    h.rt.getConfig().specReviewGate = false;
    const first = h.rt.getState().tasks[0];
    const res = await h.tool({ action: "complete", task_id: String(first.ref) });
    assert.match(res.content[0].text, /✓/, `gate off must allow completion: ${res.content[0].text}`);
    assert.equal(h.rt.getState().tasks[0].status, "done");
  } finally {
    await h.cleanup();
  }
});

test("bulk plan is capped so a huge payload cannot explode the state", async () => {
  const h = await createHarness({ sessionId: "specmem016" });
  try {
    const text = Array.from({ length: 250 }, (_, i) => `Task number ${i}`).join("\n");
    const res = await h.tool({ action: "plan", task_text: text, lane: "backlog" });
    assert.match(res.content[0].text, /\+200 tasks/);
    assert.match(res.content[0].text, /50 lines ignored/);
    assert.equal(h.rt.getState().tasks.length, 200);
  } finally {
    await h.cleanup();
  }
});

test("a referenced documentation file is not ingested by default (F-1/F-2)", async () => {
  const h = await createHarness({ sessionId: "specmem017" });
  try {
    await mkdir(join(h.cwd, "docs"), { recursive: true });
    await writeFile(
      join(h.cwd, "docs/CONTINUATION.md"),
      "# Continuation\n\nPurpose: everything a new session needs to pick this up\n\n## Files touched\n- src/a.ts\n- src/b.ts\n",
      "utf-8"
    );
    await h.rt.onBeforeAgentStart({ prompt: "pick up where we left off, see docs/CONTINUATION.md", systemPrompt: "" }, h.ctx);
    assert.equal(h.rt.getState().specs, undefined, "a mention alone must not create a spec source");

    // Even opted in, a documentation file is refused unless it declares itself a spec.
    h.rt.getConfig().specIngestFiles = true;
    await h.rt.onBeforeAgentStart({ prompt: "keep going, see docs/CONTINUATION.md", systemPrompt: "" }, h.ctx);
    assert.equal(h.rt.getState().specs, undefined, "CONTINUATION.md must never be ingested");

    // A declared spec doc referenced in the prompt is ingested once opted in.
    await writeFile(
      join(h.cwd, "app-spec.md"),
      "# App\n\n## Requirements\n- The system MUST authenticate users via OAuth2.\n- Must persist sessions in Postgres.\n",
      "utf-8"
    );
    await h.rt.onBeforeAgentStart({ prompt: "implement app-spec.md", systemPrompt: "" }, h.ctx);
    assert.equal(h.rt.getState().specs?.length, 1, "a declared spec doc must be ingested when opted in");
    assert.ok((h.rt.getState().requirements?.length ?? 0) >= 2);
  } finally {
    await h.cleanup();
  }
});

test("source refuses protected paths even though it is explicit (F-2)", async () => {
  const h = await createHarness({ sessionId: "specmem023" });
  try {
    await writeFile(join(h.cwd, "pi.md"), "# memory\n- The system MUST authenticate users.\n", "utf-8");
    await writeFile(join(h.cwd, "plan_app.md"), "# plan\n- Must do the thing.\n", "utf-8");
    for (const ref of ["pi.md", "plan_app.md"]) {
      const res = await h.tool({ action: "source", task_text: ref });
      assert.match(res.content[0].text, /Refusing to ingest protected path/, `${ref} must be refused`);
    }
    assert.equal(h.rt.getState().specs?.length ?? 0, 0, "no protected file may become a source");
  } finally {
    await h.cleanup();
  }
});

test("plan_manager forget retracts a source, its requirements and tasks (F-5)", async () => {
  const h = await createHarness({ sessionId: "specmem018" });
  try {
    await seed(h);
    const before = h.rt.getState();
    assert.equal(before.specs.length, 1);
    const sourceId = before.specs[0].id;

    const res = await h.tool({ action: "forget", task_text: sourceId });
    assert.match(res.content[0].text, /Forgot/);
    const after = h.rt.getState();
    assert.equal(after.specs.length, 0, "the source must be gone");
    assert.equal(after.requirements.length, 0, "its requirements must be gone");
    assert.equal(after.tasks.length, 0, "tasks that only covered those requirements must be gone");

    // Re-ingesting the same prompt must not resurrect the forgotten source.
    await seed(h);
    assert.equal(h.rt.getState().specs.length, 0, "a forgotten source stays forgotten");
  } finally {
    await h.cleanup();
  }
});

test("forget is durable across a reload (regression: stale plan file)", async () => {
  const h = await createHarness({ sessionId: "specmem020" });
  const cwd = h.cwd;
  try {
    await seed(h);
    const sourceId = h.rt.getState().specs[0].id;
    await h.tool({ action: "forget", task_text: sourceId });
    assert.equal(h.rt.getState().specs.length, 0);

    await h.stop();
    // A new session over the same project must NOT re-adopt what was retracted.
    const h2 = await createHarness({ sessionId: "specmem021", cwd });
    try {
      assert.equal(h2.rt.getState().specs?.length ?? 0, 0, "forget must survive a reload");
      assert.equal(h2.rt.getState().requirements?.length ?? 0, 0, "retracted requirements must not resurrect");
      assert.equal(h2.rt.getState().tasks.length, 0);
    } finally {
      await h2.cleanup();
    }
  } finally {
    await h.cleanup();
  }
});

test("the source budget prunes the oldest source without hanging", async () => {
  const h = await createHarness({ sessionId: "specmem022" });
  try {
    // Regression: retractSource replaces state.specs, so the prune loop must
    // re-read it or it spins forever on the already-retracted source.
    for (let i = 1; i <= 9; i++) {
      await seedOne(
        h,
        `# Spec ${i}\n\n## Requirements\n- The system MUST perform unique behaviour number ${i}.\n- Must handle case ${i} correctly.\n`
      );
    }
    const state = h.rt.getState();
    assert.equal(state.specs.length, 8, "at most MAX_SPEC_SOURCES documents stay active");
    assert.ok(!state.specs.some((s) => s.id === "S1"), "the oldest source must be pruned");
    assert.ok(!state.requirements.some((r) => r.sourceId === "S1"), "its requirements must be pruned too");
    assert.equal(state.requirements.length, 16, "8 sources x 2 requirements");
    for (const r of state.requirements) {
      assert.ok(state.specs.some((s) => s.id === r.sourceId), `${r.id} must trace to a live source`);
    }
  } finally {
    await h.cleanup();
  }
});

test("source explains the project requirement cap instead of a generic message", async () => {
  const h = await createHarness({ sessionId: "specmem024" });
  try {
    for (let i = 1; i <= 3; i++) {
      const lines = Array.from({ length: 80 }, (_, j) => `- The system MUST operation ${i}-${j} now.`).join("\n");
      await seedOne(h, `# Big ${i}\n\n## Requirements\n${lines}\n`);
    }
    assert.equal(h.rt.getState().requirements.length, 200, "the ledger is capped at MAX_PROJECT_REQUIREMENTS");
    await writeFile(join(h.cwd, "brand-new-spec.md"), "# New\n\n## Requirements\n- Must add a fresh capability.\n", "utf-8");
    const res = await h.tool({ action: "source", task_text: "brand-new-spec.md" });
    assert.match(res.content[0].text, /cap reached/, `expected a cap message, got: ${res.content[0].text}`);
  } finally {
    await h.cleanup();
  }
});

test("re-ingesting the same spec is idempotent", async () => {
  const h = await createHarness({ sessionId: "specmem019" });
  try {
    await seed(h);
    const n = h.rt.getState().requirements.length;
    await seed(h);
    assert.equal(h.rt.getState().requirements.length, n, "the same source must not add requirements twice");
    assert.equal(h.rt.getState().specs.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("plain short prompts do not seed anything", async () => {
  const h = await createHarness({ sessionId: "specmem008" });
  try {
    await h.rt.onBeforeAgentStart({ prompt: "fix the typo in the readme please", systemPrompt: "" }, h.ctx);
    assert.equal(h.rt.getState().specs, undefined);
    assert.equal(h.rt.getState().tasks.length, 0);
  } finally {
    await h.cleanup();
  }
});
