/**
 * Adversarial QA of the unified plan-file lifecycle (src/runtime.ts).
 *
 * Execution-based regression tests for the ten scenarios of the QA task:
 *   (a) new session adopts the unified file, refs/status survive
 *   (b) a resumed session (entries carry plan-state) is not clobbered by an older file
 *   (c) legacy adoption only for a matching title slug, newest wins, unrelated untouched
 *   (d) adoption when the unified target already exists does not crash or lose the file
 *   (e) two runtimes interleaved on one cwd do not throw and leave a parseable file
 *   (f) touchSession caps at 20 and never duplicates an id
 *   (g) ensurePlanFileGitIgnored is idempotent, adds <prefix>_*.md once, no .gitignore /
 *       no trailing newline
 *   (h) the reset (purge) command removes the unified file and does not throw when absent
 *   (i) writePlanFile no-ops when there are zero tasks
 *   (j) scanPlanFiles ignores non-plan .md and tolerates an unreadable plan entry
 *
 * Everything runs against the temp HOME/cwd created by tests/helpers/harness.mjs:
 * no real project file is ever read or written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();
const u = await import("../src/utils.ts");

/** Temp project directory whose basename drives the auto title (`<name> Plan`). */
async function projectDir(name) {
  const root = await mkdtemp(join(tmpdir(), "tplan-qa-"));
  const cwd = join(root, name);
  await mkdir(cwd, { recursive: true });
  return cwd;
}

/** Removes the whole temp root that backs `cwd`. */
const removeDir = (cwd) => rm(dirname(cwd), { recursive: true, force: true });

const mdFiles = (cwd) =>
  readdir(cwd).then((names) => names.filter((n) => n.endsWith(".md")).sort());

const legacyPending = (title, task) =>
  [`# ${title}`, "", "## ⏳ Pending", "", `- [ ] #1. ${task}`, ""].join("\n");

// ── (a) ─────────────────────────────────────────────────────────────────────────
test("(a) a brand-new session adopts the unified file and preserves refs/status", async () => {
  const cwd = await projectDir("adoptapp");
  await writeFile(
    join(cwd, "plan_adoptapp.md"),
    [
      "# adoptapp Plan",
      "",
      "## ✅ Completed",
      "",
      "- [x] #7. done thing (took 00:00:03) (→ t2)",
      "",
      "## ⏳ Pending",
      "",
      "- [ ] #9. pending thing (→ t3)",
      "",
    ].join("\n"),
    "utf-8"
  );

  const h = await createHarness({ cwd, sessionId: "adoptA01" });
  try {
    const rows = await h.plan();
    assert.deepEqual(
      rows.map((r) => [r.ref, r.status]),
      [[7, "done"], [9, "pending"]],
      `refs and statuses must survive adoption: ${JSON.stringify(rows)}`
    );
    assert.equal(rows[0].text, "done thing");
    assert.equal(rows[1].text, "pending thing");

    // and the on-disk unified file is still a valid plan after the session re-writes it
    const reparsed = u.extractPlanTasks(await readFile(join(cwd, "plan_adoptapp.md"), "utf-8"));
    assert.equal(reparsed.length, 2);
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});

// ── (b) ─────────────────────────────────────────────────────────────────────────
test("(b) a resumed session keeps its plan and is not clobbered by the older file", async () => {
  const cwd = await projectDir("resumeapp");
  const h = await createHarness({ cwd, sessionId: "resumeA1" });
  try {
    await h.addTasks(["Newer in-session task"]);
    await h.tool({ action: "complete", task_id: "1" });

    // An older shared file appears on disk after the session state was built.
    await writeFile(
      join(cwd, "plan_resumeapp.md"),
      legacyPending("resumeapp Plan", "STALE disk task"),
      "utf-8"
    );

    // Simulate resume/reload: the persisted entries already carry plan-state.
    await h.rt.onSessionStart({ type: "session_start" }, h.ctx);

    const rows = await h.plan();
    assert.deepEqual(
      rows.map((r) => [r.text, r.status]),
      [["Newer in-session task", "done"]],
      `the in-session plan must win over the older file: ${JSON.stringify(rows)}`
    );
    const md = await readFile(join(cwd, "plan_resumeapp.md"), "utf-8");
    assert.match(md, /Newer in-session task/, "the newer session state is written back");
    assert.doesNotMatch(md, /STALE disk task/, "the older disk tasks never re-enter");
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});

// ── (c) ─────────────────────────────────────────────────────────────────────────
test("(c) legacy adoption matches the slug, newest wins, unrelated file untouched", async () => {
  const cwd = await projectDir("legapp");
  const older = legacyPending("legapp Plan", "old legacy task");
  const newer = legacyPending("legapp Plan", "new legacy task");
  const unrelated = legacyPending("other Plan", "unrelated task");

  await writeFile(join(cwd, "plan_legapp_old00001.md"), older, "utf-8");
  await new Promise((r) => setTimeout(r, 30)); // guarantee a distinct mtime
  await writeFile(join(cwd, "plan_legapp_new00002.md"), newer, "utf-8");
  await writeFile(join(cwd, "plan_other_zzz00009.md"), unrelated, "utf-8");

  const h = await createHarness({ cwd, sessionId: "legA0001" });
  try {
    const rows = await h.plan();
    assert.deepEqual(rows.map((r) => r.text), ["new legacy task"]);

    const names = await readdir(cwd);
    assert.ok(names.includes("plan_legapp.md"), "the newest legacy became the unified file");
    assert.equal(
      await readFile(join(cwd, "plan_legapp_old00001.md"), "utf-8"),
      older,
      "the older matching legacy is left untouched"
    );
    assert.equal(
      await readFile(join(cwd, "plan_other_zzz00009.md"), "utf-8"),
      unrelated,
      "a legacy file for another slug is never adopted"
    );
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});

// ── (d) ─────────────────────────────────────────────────────────────────────────
test("(d) adoption with an existing unified target neither crashes nor loses it", async () => {
  const cwd = await projectDir("dupapp");
  const unified = legacyPending("dupapp Plan", "unified task here");
  const legacy = legacyPending("dupapp Plan", "legacy task here");
  await writeFile(join(cwd, "plan_dupapp.md"), unified, "utf-8");
  await writeFile(join(cwd, "plan_dupapp_abcd1234.md"), legacy, "utf-8");

  const h = await createHarness({ cwd, sessionId: "dupA0001" });
  try {
    const rows = await h.plan();
    assert.deepEqual(rows.map((r) => r.text), ["unified task here"], "the existing unified file wins");

    assert.deepEqual(
      await mdFiles(cwd),
      ["plan_dupapp.md", "plan_dupapp_abcd1234.md"],
      "no file is created or lost"
    );
    assert.equal(
      await readFile(join(cwd, "plan_dupapp_abcd1234.md"), "utf-8"),
      legacy,
      "the legacy file is not overwritten by mistake"
    );
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});

// ── (e) ─────────────────────────────────────────────────────────────────────────
test("(e) two runtimes interleaved on one cwd do not throw and leave a parseable file", async () => {
  const cwd = await projectDir("interapp");
  const h1 = await createHarness({ cwd, sessionId: "interA01" });
  const h2 = await createHarness({ cwd, sessionId: "interB02" });
  try {
    await assert.doesNotReject(async () => {
      await h1.addTasks(["A task one"]);
      await h2.addTasks(["B task one"]);
      await h1.tool({ action: "complete", task_id: "1" });
      await h2.addTasks(["B task two"]);
      await h1.addTasks(["A task two"]);
    }, "interleaved writers must not throw");

    await h2.rt.onSessionShutdown({}, h2.ctx);
    await h1.rt.onSessionShutdown({}, h1.ctx);

    assert.deepEqual(await mdFiles(cwd), ["plan_interapp.md"], "exactly one unified file");
    const md = await readFile(join(cwd, "plan_interapp.md"), "utf-8");
    assert.match(md, /^# /m, "still a plan document");
    assert.ok(u.extractPlanTasks(md).length >= 1, "still parseable");
  } finally {
    await h2.cleanup();
    await h1.cleanup();
    await removeDir(cwd);
  }
});

// ── (f) ─────────────────────────────────────────────────────────────────────────
test("(f) touchSession caps the history at 20 and never duplicates an id", async () => {
  const cwd = await projectDir("sessapp");
  const h = await createHarness({ cwd, sessionId: "seed0000" });
  try {
    await h.addTasks(["seed task for the session history"]);

    for (let i = 0; i < 25; i++) {
      const id = `sess${String(i).padStart(4, "0")}`;
      h.ctx.sessionManager.getSessionId = () => id;
      await h.rt.onSessionStart({ type: "session_start" }, h.ctx);
    }
    // Re-touching the newest id several times must not create duplicates.
    for (let k = 0; k < 3; k++) {
      h.ctx.sessionManager.getSessionId = () => "sess0024";
      await h.rt.onSessionStart({ type: "session_start" }, h.ctx);
    }

    const sessions = u.parsePlanSessions(await h.planFile());
    assert.equal(sessions.length, 20, "capped at the 20 newest sessions");
    assert.equal(new Set(sessions.map((s) => s.id)).size, 20, "no duplicated session id");
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});

// ── (g) ─────────────────────────────────────────────────────────────────────────
test("(g) gitignore: idempotent, one <prefix>_*.md, works w/o file and w/o trailing NL", async () => {
  // (1) existing .gitignore without a trailing newline (default prefix)
  const cwd1 = await projectDir("gitapp");
  await mkdir(join(cwd1, ".git"));
  await writeFile(join(cwd1, ".gitignore"), "node_modules", "utf-8");
  const h1 = await createHarness({ cwd: cwd1, sessionId: "gitA0001" });
  try {
    await h1.addTasks(["a task for the gitignore"]);
    const gi1 = await readFile(join(cwd1, ".gitignore"), "utf-8");
    assert.ok(gi1.startsWith("node_modules\n"), "existing content preserved, newline inserted");
    assert.equal((gi1.match(/^plan_\*\.md$/gm) ?? []).length, 1, "plan_*.md added exactly once");
    assert.match(gi1, /# t-plan:/, "adds the private-state header");

    await h1.rt.tPlanCommand.handler("save", h1.ctx);
    assert.equal(
      await readFile(join(cwd1, ".gitignore"), "utf-8"),
      gi1,
      "a second write is a no-op (idempotent)"
    );
  } finally {
    await h1.cleanup();
    await removeDir(cwd1);
  }

  // (2) no .gitignore at all + a custom prefix from the config menu
  const cwd2 = await projectDir("gitapp2");
  await mkdir(join(cwd2, ".git"));
  const h2 = await createHarness({ cwd: cwd2, sessionId: "gitB0002" });
  try {
    h2.ctx.ui.select = async () => "📄 Prefix: plan";
    h2.ctx.ui.input = async () => "myplan";
    await h2.rt.tPlanCommand.handler("config", h2.ctx);
    await h2.addTasks(["a task for the custom prefix"]);

    const gi2 = await readFile(join(cwd2, ".gitignore"), "utf-8");
    assert.equal((gi2.match(/^myplan_\*\.md$/gm) ?? []).length, 1, "custom prefix added exactly once");
    assert.doesNotMatch(gi2, /^plan_\*\.md$/m, "the default prefix is not added");

    await h2.rt.tPlanCommand.handler("save", h2.ctx);
    assert.equal(await readFile(join(cwd2, ".gitignore"), "utf-8"), gi2, "idempotent with a fresh file");
  } finally {
    await h2.cleanup();
    await removeDir(cwd2);
  }
});

// ── (h) ─────────────────────────────────────────────────────────────────────────
test("(h) purge removes the unified file and never throws when it is absent", async () => {
  const cwd = await projectDir("purgeapp");
  const h = await createHarness({ cwd, sessionId: "purgeA01" });
  try {
    await h.addTasks(["task to purge"]);
    assert.deepEqual(await mdFiles(cwd), ["plan_purgeapp.md"]);

    await h.rt.tPlanCommand.handler("purge", h.ctx);
    assert.deepEqual(await mdFiles(cwd), [], "purge removes the unified file");
    assert.ok(h.notes.some((n) => n.msg === "purged"));

    // Absent file: a silent no-op, not a throw.
    await assert.doesNotReject(() => h.rt.tPlanCommand.handler("purge", h.ctx));
    assert.deepEqual(await mdFiles(cwd), []);

    // The config-menu purge path had the same bug: regression-cover it too.
    await h.addTasks(["task to purge from the menu"]);
    assert.deepEqual(await mdFiles(cwd), ["plan_purgeapp.md"]);
    h.ctx.ui.select = async () => "🧹 Purge";
    await h.rt.tPlanCommand.handler("config", h.ctx);
    assert.deepEqual(await mdFiles(cwd), [], "config-menu purge removes the unified file");
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});

// ── (i) ─────────────────────────────────────────────────────────────────────────
test("(i) writePlanFile does not create a file when the plan has zero tasks", async () => {
  const cwd = await projectDir("zeroapp");
  const h = await createHarness({ cwd, sessionId: "zeroA001" });
  try {
    await h.rt.tPlanCommand.handler("save", h.ctx);
    assert.deepEqual(await mdFiles(cwd), [], "zero tasks => no plan file");
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});

// ── (j) ─────────────────────────────────────────────────────────────────────────
test("(j) scanPlanFiles ignores non-plan .md and tolerates an unreadable entry", async () => {
  const cwd = await projectDir("scanapp");
  await writeFile(join(cwd, "README.md"), "# Readme\n\n1. one\n2. two\n3. three\n", "utf-8");
  await writeFile(join(cwd, "notes.md"), "# notes\n", "utf-8");
  // A directory named like a plan file: readFile always fails (EISDIR), even as root.
  await mkdir(join(cwd, "plan_scanapp_bad00001.md"));
  await writeFile(
    join(cwd, "plan_scanapp_deadbeef.md"),
    legacyPending("scanapp Plan", "real legacy task"),
    "utf-8"
  );

  const h = await createHarness({ cwd, sessionId: "scanA001" });
  try {
    const rows = await h.plan();
    assert.deepEqual(rows.map((r) => r.text), ["real legacy task"]);

    const names = await readdir(cwd);
    assert.ok(names.includes("plan_scanapp.md"), "the matching legacy was migrated");
    assert.ok(names.includes("plan_scanapp_bad00001.md"), "the unreadable entry is left in place");
    assert.ok(names.includes("README.md") && names.includes("notes.md"), "non-plan .md untouched");
  } finally {
    await h.cleanup();
    await removeDir(cwd);
  }
});
