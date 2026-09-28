/**
 * Round-trip coverage for the plan-file serialization added by the spec-driven
 * memory: lane/reqs markers, the per-task spec/check/verified continuation and
 * the Specs/Requirements sections. The parser must never turn metadata bullets
 * into tasks, and a legacy file without any of it must keep parsing as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";

await ensurePeers();

const { generatePlanMarkdown, parsePlanSpecs, extractPlanTasks } = await import("../src/utils.ts");

const baseState = (over = {}) => ({
  enabled: true,
  title: "App Plan",
  titleAuto: false,
  createdAt: 1,
  updatedAt: 1,
  autoDetect: true,
  showWidget: true,
  widgetPlacement: "aboveEditor",
  ...over,
});

test("the plan file says it is auto-generated so edits are not silently lost (F-7b)", () => {
  const md = generatePlanMarkdown(baseState({ tasks: [] }), { showTimers: false });
  assert.match(md, /AUTO-GENERATED/);
  assert.equal(extractPlanTasks(md, { minLength: 1 }).length, 0, "the header must not become a task");
});

test("lane and reqs markers survive generatePlanMarkdown -> extractPlanTasks", () => {
  const state = baseState({
    tasks: [
      { id: "t1", ref: 1, text: "Implement OAuth login", status: "pending", order: 1, lane: "active", reqs: ["R1"] },
      { id: "t2", ref: 2, text: "Expose login endpoint", status: "pending", order: 2, lane: "backlog", reqs: ["R2", "R3"] },
      { id: "t3", ref: 3, text: "Parked polish", status: "pending", order: 3, lane: "paused" },
    ],
  });
  const md = generatePlanMarkdown(state, { showTimers: false });
  assert.ok(md.includes("(lane:backlog)"), "backlog lane marker must be written");
  assert.ok(md.includes("(lane:paused)"), "paused lane marker must be written");
  assert.ok(!md.includes("(lane:active)"), "the default active lane is not written");
  assert.ok(md.includes("(reqs:R2,R3)"), "reqs marker must be written");

  const tasks = extractPlanTasks(md, { minLength: 1 });
  assert.equal(tasks.length, 3, `expected 3 tasks, got ${tasks.length}`);
  const byRef = Object.fromEntries(tasks.map((t) => [t.ref, t]));
  assert.deepEqual(byRef[2].reqs, ["R2", "R3"]);
  assert.equal(byRef[2].lane, "backlog");
  assert.equal(byRef[3].lane, "paused");
});

test("spec/check/verified continuation survives and never becomes a task", () => {
  const state = baseState({
    tasks: [
      {
        id: "t1", ref: 1, text: "Implement OAuth", status: "pending", order: 1,
        spec: "The system MUST authenticate users.", check: ["compiles/typechecks", "tests pass"],
        reqs: ["R1"],
      },
      { id: "t2", ref: 2, text: "Done thing", status: "done", order: 2, verifiedAt: 1700000000000, verifyNote: "npm test → 3 passed" },
    ],
  });
  const md = generatePlanMarkdown(state, { showTimers: false });
  assert.ok(md.includes("  - spec: The system MUST authenticate users."));
  assert.ok(md.includes("  - check: compiles/typechecks | tests pass"));
  assert.ok(md.includes("  - verified:"));
  assert.ok(md.includes("npm test → 3 passed"));

  const tasks = extractPlanTasks(md, { minLength: 1 });
  assert.equal(tasks.length, 2, "continuation lines must not become tasks");
  const first = tasks.find((t) => t.ref === 1);
  assert.equal(first.spec, "The system MUST authenticate users.");
  assert.deepEqual(first.check, ["compiles/typechecks", "tests pass"]);
  const second = tasks.find((t) => t.ref === 2);
  assert.equal(second.verifiedAt, 1700000000000);
  assert.equal(second.verifyNote, "npm test → 3 passed");
});

test("Specs/Requirements sections round-trip and never become tasks", () => {
  const state = baseState({
    specs: [{ id: "S1", kind: "file", ref: "specs/app.md", title: "App Spec", hash: "abc123", addedAt: 1, requirementCount: 2 }],
    requirements: [
      { id: "R1", sourceId: "S1", anchor: "Auth", text: "The system MUST authenticate users." },
      { id: "R2", sourceId: "S1", anchor: "API", text: "Expose POST /login." },
    ],
    tasks: [{ id: "t1", ref: 1, text: "Implement OAuth", status: "done", order: 1, reqs: ["R1"] }],
  });
  const md = generatePlanMarkdown(state, { showTimers: false });
  assert.ok(md.includes("## 📋 Specs"));
  assert.ok(md.includes("## 🎯 Requirements"));
  // R1 satisfied (task #1 done), R2 not.
  assert.ok(md.includes("- [x] R1."));
  assert.ok(md.includes("- [ ] R2."));

  const parsed = parsePlanSpecs(md);
  assert.equal(parsed.specs.length, 1);
  assert.equal(parsed.specs[0].hash, "abc123");
  assert.equal(parsed.specs[0].kind, "file");
  assert.equal(parsed.requirements.length, 2);
  assert.equal(parsed.requirements[0].anchor, "Auth");
  assert.equal(parsed.requirements[1].sourceId, "S1");

  const tasks = extractPlanTasks(md, { minLength: 1 });
  assert.equal(tasks.length, 1, "requirement bullets must not become tasks");
  assert.equal(tasks[0].text, "Implement OAuth");
});

test("a spec without a hash round-trips and parenthesised requirement text survives", () => {
  const state = baseState({
    specs: [{ id: "S1", kind: "prompt", ref: "prompt", hash: "", addedAt: 1, requirementCount: 1 }],
    requirements: [{ id: "R1", sourceId: "S1", text: "Use OAuth (RFC 6749) for login." }],
    tasks: [],
  });
  const md = generatePlanMarkdown(state, { showTimers: false });
  assert.ok(!md.includes("hash:"), "an empty hash must not be written as a dangling suffix");
  const parsed = parsePlanSpecs(md);
  assert.equal(parsed.specs.length, 1, `spec must round-trip:\n${md}`);
  assert.equal(parsed.specs[0].hash, "");
  assert.equal(parsed.requirements.length, 1);
  assert.equal(parsed.requirements[0].text, "Use OAuth (RFC 6749) for login.");
});

test("a legacy plan file without specs/lanes parses exactly as before", () => {
  const legacy = "# Legacy\n\n## ⏳ Pending\n\n- [ ] #1. First task\n- [ ] #2. Second task (→ t3)\n";
  const tasks = extractPlanTasks(legacy, { minLength: 1 });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].lane, undefined);
  assert.equal(tasks[0].reqs, undefined);
  assert.equal(tasks[1].tier, "t3");
  assert.deepEqual(parsePlanSpecs(legacy), { specs: [], requirements: [] });
});
