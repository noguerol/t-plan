import { test, before } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";

let u;

before(async () => {
  await ensurePeers();
  u = await import("../src/utils.ts");
});

// ── Naming: one unified file per project, no session id ─────────────────────────
test("planFileNameFor: unified name, never a session id", () => {
  assert.equal(u.planFileNameFor("plan", "my app Plan"), "plan_my-app.md");
  assert.equal(u.planFileNameFor("plan", ""), "plan_untitled.md");
  assert.doesNotMatch(u.planFileNameFor("plan", "myapp Plan"), /_[0-9a-f]{6,12}\.md$/i);
});

test("parsePlanFileName: legacy pattern first, unified otherwise", () => {
  assert.deepEqual(u.parsePlanFileName("plan_my-app.md", "plan"), {
    titleSlug: "my-app",
    sessionId: undefined,
    legacy: false,
  });
  assert.deepEqual(u.parsePlanFileName("plan_my-app_01a048c3.md", "plan"), {
    titleSlug: "my-app",
    sessionId: "01a048c3",
    legacy: true,
  });
  assert.equal(u.parsePlanFileName("plan_my-app_noid.md", "plan").legacy, true);
  assert.equal(u.parsePlanFileName("README.md", "plan"), null);
  assert.equal(u.parsePlanFileName("plan.md", "plan"), null); // handled as legacy single-file by the runtime
});

// ── Session stamps: deterministic local round-trip ──────────────────────────────
test("session timestamps round-trip", () => {
  const ts = new Date(2026, 8, 14, 19, 5, 21).getTime();
  assert.equal(u.formatSessionStamp(ts), "2026-09-14 19:05:21");
  assert.equal(u.parseSessionStamp("2026-09-14 19:05:21"), ts);
  assert.ok(Number.isNaN(u.parseSessionStamp("garbage")));
});

const mkState = (overrides = {}) => ({
  enabled: true,
  tasks: [],
  title: "my app Plan",
  titleAuto: false,
  createdAt: 1,
  updatedAt: 1,
  autoDetect: true,
  showWidget: true,
  widgetPlacement: "aboveEditor",
  ...overrides,
});

// ── Sessions section: round-trip, newest first, never tasks, capped at 20 ───────
test("generatePlanMarkdown + parsePlanSessions round-trip, newest first", () => {
  const state = mkState({
    tasks: [{ id: "a", ref: 1, text: "a real task", status: "pending", order: 1 }],
    sessions: [
      { id: "aaaaaa", startedAt: 1000, lastSeenAt: 2000 },
      { id: "bbbbbb", startedAt: 3000, lastSeenAt: 4000, title: "Optimize" },
    ],
  });
  const md = u.generatePlanMarkdown(state, {});
  assert.match(md, /## .*Sessions/);

  const sessions = u.parsePlanSessions(md);
  assert.deepEqual(sessions.map((s) => s.id), ["bbbbbb", "aaaaaa"]);
  assert.equal(sessions[0].title, "Optimize");
  assert.equal(sessions[0].lastSeenAt, 4000);

  const tasks = u.extractPlanTasks(md);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].text, "a real task");
});

test("sessions are capped at the 20 most recent", () => {
  const sessions = Array.from({ length: 25 }, (_, i) => ({
    id: `s${String(i).padStart(5, "0")}`,
    startedAt: i,
    lastSeenAt: i,
  }));
  const md = u.generatePlanMarkdown(mkState({ sessions }), {});
  assert.equal(u.parsePlanSessions(md).length, 20);
});

// ── Stable refs + tiers survive the unified-file round-trip ─────────────────────
test("stable #ref and tier survive the file round-trip", () => {
  const md = [
    "# p Plan",
    "",
    "## ✅ Completed",
    "",
    "- [x] #7. done thing (took 00:00:03) (→ t2)",
    "",
    "## ⏳ Pending",
    "",
    "- [ ] #9. pending thing (→ t3)",
    "",
  ].join("\n");
  const tasks = u.extractPlanTasks(md);
  const done = tasks.find((t) => t.text.includes("done thing"));
  const pending = tasks.find((t) => t.text.includes("pending thing"));
  assert.equal(done.ref, 7);
  assert.equal(done.status, "done");
  assert.equal(done.tier, "t2");
  assert.equal(pending.ref, 9);
  assert.equal(pending.tier, "t3");
});
