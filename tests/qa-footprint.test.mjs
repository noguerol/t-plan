/**
 * Adversarial QA of the SHORTENED (compressed) strings: the string-trimming
 * commits (v1.3.x) must not have silently broken the externally-observable
 * contract. Each test asserts an OBSERVABLE behavior, not a source literal,
 * except test (8) which is the explicit registration-contract grep.
 *
 * Owns ONLY this file. It never modifies src/ or any other test. Every runtime
 * test uses tests/helpers/harness.mjs with a temp HOME and temp cwd, so no real
 * project file or user config is ever read or written.
 *
 * Hypotheses:
 *   (1) onBeforeAgentStart context still carries [PLAN], the plan file name, the
 *       privacy line (never git add/commit/publish + plan_*.md), the stable-refs
 *       line and the Rules line (plan_manager + "2,3"/text task_id forms).
 *   (2) The Doing/Todo/Blocked/Done group headers are still emitted per status.
 *   (3) plan_manager still accepts task_id "3", "2,3", "2-4", "all" and text,
 *       and completion output still shows "#<ref>".
 *   (4) The foreign-write warning still says "another session"; load/resume
 *       notifications still mention the session id.
 *   (5) ensurePlanFileGitIgnored still writes a "plan_*.md" pattern line.
 *   (6) The registered contract (2 commands, 7 events, plan_manager + params)
 *       is intact in src/index.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Name of the unified plan file the runtime writes in the harness cwd. */
async function planFileName(h) {
  const names = await h.planFiles();
  const name = names.find((n) => n.startsWith("plan_") && n.endsWith(".md"));
  assert.ok(name, `expected a plan_*.md file, got ${JSON.stringify(names)}`);
  return name;
}

/** Minimal foreign plan file with a Sessions section (drives the merge guard). */
function foreignPlan(title, task, sid) {
  return [
    `# ${title}`,
    "",
    "## ⏳ Pending",
    "",
    `- [ ] #1. ${task}`,
    "",
    "## 🗂 Sessions",
    "",
    `- \`${sid}\` — first seen 2026-01-01 00:00:00, last seen 2026-01-02 00:00:00`,
    "",
  ].join("\n");
}

// ── (1) injected context keeps the whole observable contract ───────────────────
test("(1) [PLAN] context keeps file name, privacy, stable refs and Rules line", async () => {
  const h = await createHarness({ sessionId: "fpCtx000001" });
  try {
    await h.addTasks(["alpha task"]);
    const name = await planFileName(h);

    const start = await h.runStart();
    const text = start?.message?.content;
    assert.equal(typeof text, "string", "onBeforeAgentStart must return injected context");

    assert.ok(text.includes("[PLAN]"), "missing [PLAN] header");
    assert.ok(text.includes(name), `context must name the plan file (${name})`);
    assert.ok(text.includes("never git add/commit/publish"), "missing privacy line");
    assert.ok(text.includes("plan_*.md"), "missing gitignore pattern in the privacy line");
    assert.ok(text.includes("Refs (#n) are stable"), "missing stable-refs line");
    assert.ok(text.includes("Rules:"), "missing Rules: line");
    assert.match(text, /Rules:[^\n]*plan_manager/, "Rules line must mention plan_manager");
    assert.ok(text.includes("2,3"), 'Rules line must document the "2,3" task_id form');
    assert.match(text.split("\n").find((l) => l.startsWith("Rules:")) ?? "", /\btext\b/, "Rules line must document the text task_id form");
  } finally {
    await h.cleanup();
  }
});

// ── (2) group headers survive the string trimming ──────────────────────────────
test("(2) Doing/Todo/Blocked/Done headers are emitted when those statuses exist", async () => {
  const h = await createHarness({ sessionId: "fpGrp000001" });
  try {
    await h.addTasks(["doing one", "blocked two", "done three", "todo four"]);
    await h.tool({ action: "start", task_id: "1" });
    await h.tool({ action: "block", task_id: "2" });
    await h.tool({ action: "complete", task_id: "3" });

    const start = await h.runStart();
    const text = start?.message?.content;
    assert.equal(typeof text, "string", "context must be injected with tasks present");
    assert.ok(text.includes("Doing:"), "missing Doing: group header");
    assert.ok(text.includes("Todo:"), "missing Todo: group header");
    assert.ok(text.includes("Blocked:"), "missing Blocked: group header");
    assert.ok(text.includes("Done ("), "missing Done (...) group header");
  } finally {
    await h.cleanup();
  }
});

// ── (3) the [TG] block is still injected when trimegisto is on ─────────────────
test("(3) trimegisto mode still injects a [TG] block with available:", async () => {
  const h = await createHarness({ sessionId: "fpTg0000001" });
  try {
    await h.addTasks(["tg task"]);
    // Enable trimegisto through the real config menu (label while currently OFF).
    h.ctx.ui.select = async () => "❌ TG: OFF";
    await h.rt.tPlanCommand.handler("config", h.ctx);

    const start = await h.runStart();
    const text = start?.message?.content;
    assert.ok(text.includes("[TG]"), "trimegisto mode must inject a [TG] block");
    assert.ok(text.includes("available:"), "the [TG] block must list available tiers");
  } finally {
    await h.cleanup();
  }
});

// ── (4) task_id forms + completion output still shows #<ref> ───────────────────
test("(4) plan_manager accepts 3 / 2,3 / 2-4 / all / text and shows '#<ref>'", async () => {
  const h = await createHarness({ sessionId: "fpIds000001" });
  try {
    await h.addTasks(["alpha one", "beta two", "gamma three", "delta four", "epsilon five"]);

    const single = await h.tool({ action: "complete", task_id: "3" });
    assert.match(single.content[0].text, /✓\s*#3\b/, `task_id "3": ${single.content[0].text}`);

    const list = await h.tool({ action: "complete", task_id: "2,3" });
    assert.match(list.content[0].text, /#2\b/, `task_id "2,3" must resolve #2: ${list.content[0].text}`);
    assert.match(list.content[0].text, /#3\b/, `task_id "2,3" must resolve #3: ${list.content[0].text}`);

    const range = await h.tool({ action: "complete", task_id: "2-4" });
    for (const ref of [2, 3, 4]) {
      assert.match(range.content[0].text, new RegExp(`#${ref}\\b`), `task_id "2-4" must resolve #${ref}: ${range.content[0].text}`);
    }

    const all = await h.tool({ action: "complete", task_id: "all" });
    assert.match(all.content[0].text, /#1\b/, `task_id "all" must resolve #1: ${all.content[0].text}`);
    assert.match(all.content[0].text, /#5\b/, `task_id "all" must resolve #5: ${all.content[0].text}`);

    const byText = await h.tool({ action: "complete", task_id: "alpha" });
    assert.match(byText.content[0].text, /✓\s*#1\b/, `task_id by text: ${byText.content[0].text}`);
  } finally {
    await h.cleanup();
  }
});

// ── (5) foreign-write warning still says "another session" ─────────────────────
test("(5) the foreign-write warning still contains 'another session'", async () => {
  const h = await createHarness({ sessionId: "fpFrn000001" });
  try {
    await h.addTasks(["base"]);
    const name = await planFileName(h);

    await sleep(30);
    await writeFile(join(h.cwd, name), foreignPlan("Foreign FP", "foreign fp", "foreignFP01"), "utf-8");

    h.notes.length = 0;
    await h.addTasks(["after"]); // detects the foreign write + merges + writes
    await h.addTasks(["flush"]); // updateUI flushes the pending warning

    assert.ok(
      h.notes.some((n) => String(n.msg).includes("another session")),
      `expected the foreign-write warning; notes=${JSON.stringify(h.notes.map((n) => n.msg))}`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (6) load/resume notification still mentions the session id ─────────────────
test("(6) the resume notification still mentions the legacy session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "tplan-fp-load-"));
  const cwd = join(root, "loadproj");
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "plan_legacyproj_sessAB12.md"),
    ["# Legacy Title", "", "## ⏳ Pending", "", "- [ ] #1. legacy task", ""].join("\n"),
    "utf-8"
  );

  const h = await createHarness({ cwd, sessionId: "fpLoad00001" });
  try {
    h.ctx.ui.select = async () => "1";
    await h.rt.tPlanCommand.handler("load", h.ctx);
    assert.ok(
      h.notes.some((n) => String(n.msg).includes("sessAB12")),
      `expected a load/resume notification with the session id; notes=${JSON.stringify(h.notes.map((n) => n.msg))}`
    );
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

// ── (7) gitignore still gets a plan_*.md pattern line ──────────────────────────
test("(7) ensurePlanFileGitIgnored still writes a 'plan_*.md' pattern line", async () => {
  const root = await mkdtemp(join(tmpdir(), "tplan-fp-git-"));
  const cwd = join(root, "gitproj");
  await mkdir(join(cwd, ".git"), { recursive: true }); // findGitRoot only needs the .git dir

  const h = await createHarness({ cwd, sessionId: "fpGit000001" });
  try {
    await h.addTasks(["gitignore task"]);
    const gi = await readFile(join(cwd, ".gitignore"), "utf-8");
    assert.match(gi, /^plan_\*\.md$/m, `.gitignore must contain the plan_*.md pattern; got:\n${gi}`);
  } finally {
    await h.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

// ── (8) src/index.ts registration contract is intact ───────────────────────────
test("(8) src/index.ts keeps 2 commands, 7 events, plan_manager and its params", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = await readFile(join(here, "..", "src", "index.ts"), "utf-8");

  const required = [
    'registerCommand("t-plan"',
    'registerCommand("task"',
    '"session_start"',
    '"before_agent_start"',
    '"tool_result"',
    '"turn_end"',
    '"agent_end"',
    '"agent_settled"',
    '"session_shutdown"',
    'name: "plan_manager"',
    "action:",
    "task_text:",
    "task_id:",
    "status:",
    "notes:",
    "tier:",
  ];
  for (const token of required) {
    assert.ok(src.includes(token), `src/index.ts is missing registered contract token: ${token}`);
  }
});
