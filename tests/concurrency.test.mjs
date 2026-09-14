/**
 * Foreign-write concurrency guard (src/runtime.ts): two pi sessions sharing the
 * same project plan file must not silently lose each other's session history.
 * Task state stays last-write-wins.
 *
 * A session tracks the mtime of the plan file it last wrote. If, just before the
 * next write, the file on disk is newer than that (by more than 1ms of slack), it
 * was written by somebody else: its Sessions section is merged into the in-memory
 * history and a warning is queued, flushed on the next UI refresh.
 *
 * Harness: tests/helpers/harness.mjs — temp HOME + temp cwd, notes/widget capture.
 * Nothing here ever reads or writes a real project file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

const WARN = "plan file was updated by another session";
const warns = (h) => h.notes.some((n) => String(n.msg).includes(WARN));
const msgs = (h) => JSON.stringify(h.notes.map((n) => n.msg));

/** The `plan_*.md` file the runtime writes in the harness cwd. */
async function planFileName(h) {
  const names = await h.planFiles();
  const name = names.find((n) => n.startsWith("plan_") && n.endsWith(".md"));
  assert.ok(name, `expected a plan_*.md file, got ${JSON.stringify(names)}`);
  return name;
}

/** A valid plan file whose Sessions section advertises the given session ids. */
function foreignPlan(title, task, ids) {
  const sessionLines = ids
    .map((id) => `- \`${id}\` — first seen 2026-01-01 00:00:00, last seen 2026-01-02 00:00:00`)
    .join("\n");
  return [
    `# ${title}`,
    "",
    "## ⏳ Pending",
    "",
    `- [ ] #1. ${task}`,
    "",
    "## 🗂 Sessions",
    "",
    sessionLines,
    "",
  ].join("\n");
}

// ── (a) foreign write ⇒ sessions merged + user warned ──────────────────────────
test("(a) a foreign write merges session history and warns", async () => {
  const h = await createHarness({ sessionId: "ownSession01" });
  try {
    await h.addTasks(["first task"]);
    const name = await planFileName(h);

    // Advance the clock so the external write's mtime clears the 1ms slack.
    await new Promise((r) => setTimeout(r, 30));
    await writeFile(
      join(h.cwd, name),
      foreignPlan("Foreign Plan", "foreign task", ["foreignSess42"]),
      "utf-8"
    );

    h.notes.length = 0;
    // The add action refreshes the UI *before* it writes, which is where the
    // foreign mtime is detected and the warning queued; it therefore surfaces on
    // the next UI refresh — the next add.
    await h.addTasks(["second task"]);
    await h.addTasks(["third task"]);

    assert.ok(warns(h), `expected the foreign-write warning, got ${msgs(h)}`);

    const final = await h.planFile();
    const sessions = final.slice(final.indexOf("## 🗂 Sessions"));
    assert.ok(sessions.includes("foreignSess42"), "foreign session id must be preserved");
    assert.ok(sessions.includes("ownSession01"), "own session id must remain");
    assert.ok(
      final.includes("second task") && final.includes("third task"),
      "own task state must win (last-write-wins)"
    );
  } finally {
    await h.cleanup();
  }
});

// ── (b) no external change ⇒ never warns ───────────────────────────────────────
test("(b) normal writes never warn (no regression)", async () => {
  const h = await createHarness();
  try {
    h.notes.length = 0;
    await h.addTasks(["one", "two", "three"]);
    await h.tool({ action: "complete", task_id: "1" });
    assert.ok(!warns(h), `unexpected warning: ${msgs(h)}`);
  } finally {
    await h.cleanup();
  }
});

// ── (c1) title change resets tracking ──────────────────────────────────────────
test("(c1) a title change resets tracking (no spurious warning on the next write)", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["before"]);
    const name = await planFileName(h);

    await new Promise((r) => setTimeout(r, 30));
    await writeFile(join(h.cwd, name), foreignPlan("X Plan", "ext", ["foreignA"]), "utf-8");

    // Re-title to the bare project basename. titleToProjectName strips the " Plan"
    // suffix, so this resolves to the SAME plan_<slug>.md — only resetting
    // lastPlanMtime can stop the newer mtime looking foreign.
    const project = h.cwd.split("/").pop();
    h.ctx.ui.input = async () => project;
    await h.rt.tPlanCommand.handler("new", h.ctx);
    assert.equal(await planFileName(h), name, "the title change must keep the same file");

    h.notes.length = 0;
    // "after" is the write under test; "flush" forces the next UI refresh so a
    // wrongly-queued foreign warning would actually be observed.
    await h.addTasks(["after"]);
    await h.addTasks(["flush"]);

    assert.ok(!warns(h), `unexpected warning after title change: ${msgs(h)}`);
    assert.ok((await h.planFile()).includes("after"), "the post-title-change task is written");
  } finally {
    await h.cleanup();
  }
});

// ── (c2) purge resets tracking ─────────────────────────────────────────────────
test("(c2) purge resets tracking so a recreated file is not flagged as foreign", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["before"]);
    const name = await planFileName(h);
    await h.rt.tPlanCommand.handler("purge", h.ctx); // deletes the file + resets tracking

    // Another session recreates the shared file. Without the reset, its newer
    // mtime would look like a foreign write on our next write.
    await new Promise((r) => setTimeout(r, 30));
    await writeFile(join(h.cwd, name), foreignPlan("P Plan", "ext", ["foreignB"]), "utf-8");

    h.notes.length = 0;
    // "after purge" is the write under test; "flush" forces the next UI refresh.
    await h.addTasks(["after purge"]);
    await h.addTasks(["flush"]);

    assert.ok(!warns(h), `unexpected warning after purge: ${msgs(h)}`);
    assert.ok((await h.planFile()).includes("after purge"), "the post-purge task is written");
  } finally {
    await h.cleanup();
  }
});
