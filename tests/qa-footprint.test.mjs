// Adversarial QA by execution: the "compressed text footprint" refactor
// (commits 52dcd27 / 9361c5b / 8686d03) must NOT change the externally-observable
// contract. This suite asserts the shortened strings still carry every semantic
// anchor other sessions/agents depend on.
//
// Owns ONLY this file. It never modifies src/ or any other test. Every runtime
// test uses the shared harness (tests/helpers/harness.mjs) with a temp HOME and a
// temp cwd, so no real project file or user config is ever read or written.
//
// One test per hypothesis (1)-(6). Any failure is kept as evidence; the minimal
// fix is reported in the failure message (src/ is never edited from here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allText = (h) => JSON.stringify(h.notes.map((n) => n.msg));

/** Minimal plan markdown the runtime's own parser (extractPlanTasks) understands. */
const planMd = (title, task) => `# ${title}\n\n## ⏳ Pending\n\n- [ ] #1. ${task}\n`;

async function planFileName(h) {
  const names = await h.planFiles();
  const name = names.find((n) => n.startsWith("plan_") && n.endsWith(".md"));
  assert.ok(name, `expected a plan_*.md file, got ${JSON.stringify(names)}`);
  return name;
}

// ── (1) the injected onBeforeAgentStart context ────────────────────────────────
test("(1) injected context keeps [PLAN], file, privacy, refs and Rules contract", async () => {
  const h = await createHarness({ sessionId: "footprint001" });
  try {
    await h.addTasks(["anchor task"]);
    const name = await planFileName(h);

    const res = await h.runStart();
    const c = res?.message?.content;
    assert.equal(res?.message?.customType, "plan-context", "onBeforeAgentStart must still return the plan-context message");
    assert.ok(typeof c === "string" && c.length > 0, "injected plan context is empty");

    assert.ok(c.includes("[PLAN]"), "missing '[PLAN]' marker");
    assert.ok(c.includes(name), `injected context must name the plan file (${name})`);

    // Privacy line — the exact wording may change, the contract may not.
    assert.ok(c.includes("never git add/commit/publish"), "missing 'never git add/commit/publish' privacy clause");
    assert.ok(c.includes("plan_*.md"), "privacy line must mention the gitignore pattern plan_*.md");

    assert.ok(c.includes("Refs (#n) are stable"), "missing 'Refs (#n) are stable' guarantee");

    // Rules line: must still tell the model to call plan_manager with the
    // accepted task_id formats ("2,3" list and free text).
    const rulesLine = c.split("\n").find((l) => l.startsWith("Rules:"));
    assert.ok(rulesLine, "missing the 'Rules:' line");
    assert.ok(rulesLine.includes("plan_manager"), "Rules line must mention plan_manager");
    assert.ok(rulesLine.includes('"2,3"'), 'Rules line must show the "2,3" task_id list form');
    assert.ok(rulesLine.includes("text"), "Rules line must mention the text task_id form");
  } finally {
    await h.cleanup();
  }
});

test("(1b) trimegisto-enabled context still emits a [TG] block with available:", async () => {
  const h = await createHarness({ sessionId: "footprintTG1" });
  try {
    await h.addTasks(["tg anchor"]);
    // Enable TG through the real config menu (same path a user takes).
    h.ctx.ui.select = async () => "❌ TG: OFF";
    await h.rt.tPlanCommand.handler("config", h.ctx);

    const res = await h.runStart();
    const c = res?.message?.content ?? "";
    assert.ok(c.includes("[TG]"), "trimegisto mode must still inject a [TG] block");
    const tgBlock = c.slice(c.indexOf("[TG]"));
    assert.ok(tgBlock.includes("available:"), "[TG] block must still list 'available:' tiers");
  } finally {
    await h.cleanup();
  }
});

// ── (2) plan group headers survive the string trim ─────────────────────────────
test("(2) Doing/Todo/Blocked/Done group headers are emitted when statuses exist", async () => {
  const h = await createHarness({ sessionId: "footprint002" });
  try {
    await h.addTasks(["do me", "todo me", "block me", "done me"]);
    await h.tool({ action: "start", task_id: "1" });
    await h.tool({ action: "block", task_id: "3" });
    await h.tool({ action: "complete", task_id: "4" });

    const c = (await h.runStart())?.message?.content ?? "";
    assert.ok(c.includes("Doing:"), "missing 'Doing:' group header for in_progress tasks");
    assert.ok(c.includes("Todo:"), "missing 'Todo:' group header for pending tasks");
    assert.ok(c.includes("Blocked:"), "missing 'Blocked:' group header for blocked tasks");
    assert.ok(/Done \(\d+\):/.test(c), "missing 'Done (n):' group header for completed tasks");
    assert.ok(c.includes("#4"), "Done header must list the completed refs");
  } finally {
    await h.cleanup();
  }
});

// ── (3) plan_manager task_id forms + completion output ─────────────────────────
test("(3) plan_manager accepts '3', '2,3', '2-4', 'all' and text; completion shows #ref", async () => {
  const h = await createHarness({ sessionId: "footprint003" });
  try {
    await h.addTasks(["alpha one", "beta two", "gamma three", "delta four", "epsilon five", "zeta six"]);

    const out = async (task_id) => (await h.tool({ action: "complete", task_id })).content[0].text;

    const single = await out("3");
    assert.ok(single.includes("✓ #3"), `'3' must complete #3 and show it, got: ${single}`);
    assert.match(single, /#[0-9]+/, "completion output must still show '#<ref>'");

    const list = await out("2,3");
    assert.ok(list.includes("#2") && list.includes("#3"), `'2,3' must resolve #2 and #3, got: ${list}`);

    const range = await out("2-4");
    assert.ok(range.includes("#4"), `'2-4' must resolve the range up to #4, got: ${range}`);

    const all = await out("all");
    assert.ok(all.includes("#5") && all.includes("#6"), `'all' must complete every non-done task, got: ${all}`);

    const byText = await out("beta two");
    assert.ok(byText.includes("#2"), `text task_id must resolve #2, got: ${byText}`);
  } finally {
    await h.cleanup();
  }
});

// ── (4) foreign-write warning + load/resume session id ─────────────────────────
test("(4a) foreign-write warning still says 'another session'", async () => {
  const h = await createHarness({ sessionId: "footprint004" });
  try {
    await h.addTasks(["first"]);
    const name = await planFileName(h);

    await sleep(30);
    await writeFile(join(h.cwd, name), planMd("Foreign Plan", "foreign task"), "utf-8");

    h.notes.length = 0;
    // The add branch calls updateUI() BEFORE writePlanFile(), so the foreign guard
    // arms pendingForeignWrite on this write and the warning surfaces on the next
    // UI refresh (same double-write pattern as tests/qa-adversarial.test.mjs).
    await h.addTasks(["second"]); // detects the foreign mtime + merges + writes
    await h.addTasks(["third"]); // next updateUI flushes the pending warning

    const warning = h.notes.find((n) => String(n.msg).includes("another session"));
    assert.ok(
      warning,
      `foreign-write warning must still contain 'another session'. notes=${allText(h)} ` +
        `→ minimal fix: keep the "updated by another session" substring in updateUI's warning.`
    );
    assert.equal(warning.level, "warning", "foreign-write notice must still be a warning");
  } finally {
    await h.cleanup();
  }
});

test("(4b) load/resume notification still names the session id", async () => {
  const h = await createHarness({ sessionId: "cur0000001" });
  try {
    // Legacy session-scoped file name: plan_<slug>_<shortId>.md → sessionId recovered.
    const legacyName = "plan_legacyproj_abcd1234.md";
    await writeFile(join(h.cwd, legacyName), planMd("Legacy Proj", "legacy task"), "utf-8");

    h.ctx.ui.select = async () => "1"; // pick the only candidate
    h.notes.length = 0;
    await h.rt.tPlanCommand.handler("load", h.ctx);

    const joined = allText(h);
    assert.ok(
      joined.includes("abcd1234"),
      `load/resume notification must still mention the session id. notes=${joined} ` +
        `→ minimal fix: keep the "resume: pi --session <sessionId>" line in pickAndLoadPlan.`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (5) ensurePlanFileGitIgnored still writes the plan_*.md pattern ────────────
test("(5) ensurePlanFileGitIgnored writes a 'plan_*.md' pattern line", async () => {
  const h = await createHarness({ sessionId: "footprint005" });
  try {
    // Make the harness cwd a git root so findGitRoot() succeeds.
    await mkdir(join(h.cwd, ".git"), { recursive: true });

    await h.addTasks(["ignore me"]); // triggers writePlanFile → ensurePlanFileGitIgnored

    const gitignore = await readFile(join(h.cwd, ".gitignore"), "utf-8");
    const lines = gitignore.split(/\r?\n/).map((l) => l.trim());
    assert.ok(
      lines.includes("plan_*.md"),
      `expected a literal 'plan_*.md' pattern line (header wording may differ). got:\n${gitignore}`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (6) the registered contract in src/index.ts is intact ──────────────────────
test("(6) src/index.ts still registers 2 commands, 7 events, plan_manager + params", async () => {
  const src = await readFile(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf-8");

  const required = {
    "command t-plan": 'pi.registerCommand("t-plan"',
    "command task": 'pi.registerCommand("task"',
    "event session_start": 'pi.on("session_start"',
    "event before_agent_start": 'pi.on("before_agent_start"',
    "event tool_result": 'pi.on("tool_result"',
    "event turn_end": 'pi.on("turn_end"',
    "event agent_end": 'pi.on("agent_end"',
    "event agent_settled": 'pi.on("agent_settled"',
    "event session_shutdown": 'pi.on("session_shutdown"',
    "tool plan_manager": 'name: "plan_manager"',
    "param action": "action:",
    "param task_text": "task_text:",
    "param task_id": "task_id:",
    "param status": "status:",
    "param notes": "notes:",
    "param tier": "tier:",
  };

  const missing = Object.entries(required)
    .filter(([, needle]) => !src.includes(needle))
    .map(([label]) => label);

  assert.deepEqual(
    missing,
    [],
    `src/index.ts registration contract broken; missing: ${missing.join(", ")}`
  );
});
