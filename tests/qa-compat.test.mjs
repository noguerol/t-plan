// Adversarial backward-compatibility QA of t-plan CONFIG and PERSISTED STATE.
//
// Owns ONLY this file. It never modifies src/ or any other test. Every test uses the
// shared harness (tests/helpers/harness.mjs) with a temp HOME + temp cwd, so the real
// user config and real project plan files are never touched.
//
// Covered hypotheses:
//   (1) restoreState tolerates legacy/partial `plan-state` entries
//       (missing titleAuto, title "Project Plan", tasks without ref, sessions undefined,
//        old `planFileName` -> `planFilePrefix`)
//   (2) DEFAULT_CONFIG has exactly the documented keys; a config file with unknown keys
//       is ignored without crashing
//   (3) adopting an empty body / sessions-only body / corrupt Sessions section
//   (4) `plan_manager list` on an empty plan and complete/remove/update with an unknown
//       ref return a usable ref list without throwing
//   (5) persisted-state round-trip across session_shutdown + a fresh session (same id)
//
// If a hypothesis fails the test is KEPT and the minimal src fix is described in the
// assertion message (src/ is never edited by this file).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

let u;      // src/utils.ts
let types;  // src/types.ts

before(async () => {
  await ensurePeers();
  u = await import("../src/utils.ts");
  types = await import("../src/types.ts");
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Title of the current plan, taken from the first line of `plan_manager list`. */
async function currentTitle(h) {
  const text = (await h.tool({ action: "list" })).content[0].text;
  return text.split("\n")[0].replace(/ \(\d+\/\d+ done\)$/, "");
}

/** One well-formed Sessions bullet, exactly as generatePlanMarkdown emits it. */
function sessionLine(id, first = "2024-01-01 10:00:00", last = "2024-01-02 11:00:00") {
  return `- \`${id}\` — first seen ${first}, last seen ${last}`;
}

/** Pushes a pre-existing `plan-state` entry, shaped as an older t-plan wrote it. */
function pushLegacyEntry(h, data) {
  h.entries.push({ type: "custom", customType: "plan-state", data });
}

/** Global config path for the temp HOME the harness installed for this session. */
function globalConfigPath() {
  return join(process.env.HOME, ".pi", "agent", "t-plan", "config.json");
}

// ───────────────────────────── (1) legacy plan-state ────────────────────────────
test("(1) restoreState tolerates legacy/partial plan-state entries", async () => {
  const h = await createHarness();
  try {
    pushLegacyEntry(h, {
      // old key only: no `planFilePrefix`
      config: { planFileName: "myplan.md" },
      state: {
        title: "Project Plan", // legacy default title -> must be re-derived
        // `titleAuto` intentionally missing
        // `sessions` intentionally missing (undefined)
        tasks: [
          { id: "legacy-1", text: "legacy pending", status: "pending", order: 1 }, // no `ref`
          { id: "legacy-2", text: "legacy done", status: "done", order: 2 },       // no `ref`
        ],
      },
    });

    await h.rt.onSessionStart({}, h.ctx); // must not throw

    const title = await currentTitle(h);
    assert.notEqual(
      title,
      "Project Plan",
      "FIX: in restoreState(), when savedState.title === 'Project Plan' reset it to '' + titleAuto=true before ensureTitle()"
    );

    const tasks = await h.plan();
    assert.equal(tasks.length, 2, "legacy tasks must be restored");
    assert.deepEqual(
      tasks.map((t) => t.ref),
      [1, 2],
      "FIX: restoreState() must assignRefs() to tasks loaded without `ref` (0 -> 1..n)"
    );
    assert.deepEqual(tasks.map((t) => t.status), ["pending", "done"]);

    // `planFileName` -> `planFilePrefix` migration, observed through the injected context.
    const started = await h.runStart();
    const planContext = started?.message?.content ?? "";
    assert.match(
      planContext,
      /gitignore myplan_\*\.md/,
      "FIX: restoreState() must map legacy config.planFileName ('myplan.md') to config.planFilePrefix ('myplan')"
    );
    assert.match(planContext, /file: myplan_/);

    // sessions undefined handled and rewritten with the current session.
    // nb: the prefix is now "myplan", so harness.planFile() (which looks for `plan_*`)
    // would miss it — read the migrated file by its real name through planFiles().
    const migrated = (await h.planFiles()).find((f) => f.startsWith("myplan_"));
    assert.ok(migrated, `migrated plan file not written (files: ${JSON.stringify(await h.planFiles())})`);
    const content = await readFile(join(h.cwd, migrated), "utf-8");
    assert.match(content, /## 🗂 Sessions/);
    assert.ok(
      u.parsePlanSessions(content).some((s) => s.id === h.sessionId),
      "FIX: touchSession() must tolerate state.sessions === undefined and create the list"
    );
  } finally {
    await h.cleanup();
  }
});

test("(1b) an explicit planFilePrefix wins over the legacy planFileName", async () => {
  const h = await createHarness();
  try {
    pushLegacyEntry(h, {
      config: { planFileName: "old.md", planFilePrefix: "newpfx" },
      state: { title: "t", titleAuto: false, tasks: [], sessions: undefined },
    });
    await h.rt.onSessionStart({}, h.ctx);
    await h.addTasks(["t"]);

    const files = await h.planFiles();
    assert.ok(
      files.some((f) => f.startsWith("newpfx_")),
      `FIX: migration must not overwrite an explicit planFilePrefix (files: ${JSON.stringify(files)})`
    );
    assert.ok(!files.some((f) => f.startsWith("old_")), "legacy planFileName must not leak");
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────────── (2) config surface ───────────────────────────────
test("(2) DEFAULT_CONFIG has exactly the documented keys", () => {
  // README "Configuration" table (13 options) -> PlanConfig in src/types.ts.
  const documented = [
    "enabled",
    "autoDetect",
    "showWidget",
    "widgetPlacement",
    "planFilePrefix",
    "trackAgents",
    "animateWidget",
    "compactTaskLines",
    "highlightCompleted",
    "trimegisto",
    "showTimers",
    "toolEvidence",
    "debug",
  ].sort();

  assert.deepEqual(
    Object.keys(types.DEFAULT_CONFIG).sort(),
    documented,
    "FIX: restore a missing documented key in DEFAULT_CONFIG or remove an undocumented one"
  );
  for (const [key, value] of Object.entries(types.DEFAULT_CONFIG)) {
    assert.notEqual(value, undefined, `DEFAULT_CONFIG.${key} must have a default`);
  }
});

test("(2b) a config file with unknown extra keys loads without crashing", async () => {
  const h = await createHarness();
  try {
    // Wait for the harness' own saveGlobalConfig() write to land, then replace it.
    const path = globalConfigPath();
    for (let i = 0; i < 50; i++) {
      try {
        await access(path);
        break;
      } catch {
        await sleep(20);
      }
    }
    await sleep(30);
    await writeFile(
      path,
      JSON.stringify(
        { config: { planFilePrefix: "zzcustom", totallyUnknown: { nested: true }, legacyUnknownKey: 7 } },
        null,
        2
      ),
      "utf-8"
    );

    // Clear the session log so the persisted (older) config cannot win over the file,
    // isolating the "load global config file" path.
    h.entries.length = 0;
    await h.rt.onSessionStart({}, h.ctx); // must not throw

    const title = await currentTitle(h);
    const expected = u.planFileNameFor("zzcustom", title);
    await h.addTasks(["x"]);
    const files = await h.planFiles();
    assert.ok(
      files.includes(expected),
      `FIX: loadGlobalConfig() must keep known keys and ignore unknown ones (expected ${expected}, got ${JSON.stringify(files)})`
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(types.DEFAULT_CONFIG, "totallyUnknown"),
      false,
      "unknown keys must not become part of DEFAULT_CONFIG"
    );
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────────── (3) plan-file adoption ───────────────────────────
test("(3a) adopting an empty plan file does not throw (0 tasks, no phantom sessions)", async () => {
  const h = await createHarness();
  try {
    const title = await currentTitle(h);
    const fname = u.planFileNameFor("plan", title);
    await writeFile(join(h.cwd, fname), "", "utf-8");

    await h.rt.onSessionStart({}, h.ctx); // must not throw
    assert.equal((await h.plan()).length, 0, "an empty body must adopt 0 tasks");

    await h.addTasks(["after empty adopt"]);
    const sessions = u.parsePlanSessions(await h.planFile());
    assert.equal(
      sessions.length,
      1,
      `FIX: adoptPlanContent() must treat an empty body as 0 sessions (got ${JSON.stringify(sessions)})`
    );
    assert.equal(sessions[0].id, h.sessionId);
  } finally {
    await h.cleanup();
  }
});

test("(3b) adopting a Sessions-only plan keeps the session and adds 0 tasks", async () => {
  const h = await createHarness();
  try {
    const title = await currentTitle(h);
    const body = `# ${title}\n\n## 🗂 Sessions\n\n${sessionLine("legacy-sess-1")}\n`;
    // Sanity: the Sessions section is metadata, never tasks.
    assert.equal(u.extractPlanTasks(body, { minLength: 1 }).length, 0);
    await writeFile(join(h.cwd, u.planFileNameFor("plan", title)), body, "utf-8");

    await h.rt.onSessionStart({}, h.ctx); // must not throw
    assert.equal((await h.plan()).length, 0, "a Sessions-only body must not create tasks");

    await h.addTasks(["after sessions adopt"]);
    const ids = u.parsePlanSessions(await h.planFile()).map((s) => s.id);
    assert.equal(
      ids.length,
      2,
      `FIX: adoptPlanContent() must merge the file session with the current one (got ${JSON.stringify(ids)})`
    );
    assert.ok(ids.includes("legacy-sess-1"), "adopted session id must survive");
    assert.ok(ids.includes(h.sessionId), "current session id must be recorded");
  } finally {
    await h.cleanup();
  }
});

test("(3c) a corrupt Sessions section is ignored (no throw, only the current session)", async () => {
  const h = await createHarness();
  try {
    const title = await currentTitle(h);
    const body = [
      `# ${title}`,
      "",
      "## 🗂 Sessions",
      "",
      "garbage line without any structure",
      "- not a session entry at all",
      "- `broken` first seen nope",
      "### random subheading",
      "!!! $$$ %%%",
      "",
    ].join("\n");
    await writeFile(join(h.cwd, u.planFileNameFor("plan", title)), body, "utf-8");

    await h.rt.onSessionStart({}, h.ctx); // must not throw
    assert.equal((await h.plan()).length, 0, "garbage lines must not become tasks");

    await h.addTasks(["after corrupt adopt"]);
    const sessions = u.parsePlanSessions(await h.planFile());
    assert.equal(
      sessions.length,
      1,
      `FIX: parsePlanSessions() must skip malformed lines instead of throwing (got ${JSON.stringify(sessions)})`
    );
    assert.equal(sessions[0].id, h.sessionId);
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────────── (4) unknown refs ─────────────────────────────────
test("(4) list on an empty plan and unknown-ref ops return a usable ref list", async () => {
  const h = await createHarness();
  try {
    const list = await h.tool({ action: "list" });
    assert.match(list.content[0].text, /\(0\/0 done\)/);
    assert.equal(list.details.stats.total, 0);

    for (const action of ["complete", "remove", "update"]) {
      const res = await h.tool({ action, task_id: "999" });
      const text = res.content[0].text;
      assert.match(
        text,
        /Task not found: 999/,
        `FIX: action '${action}' must not throw on an empty plan and must report not-found`
      );
      assert.match(text, /Refs:/, `FIX: action '${action}' must always include a ref list`);
      assert.equal(res.details.notFound, "999");
    }

    await h.addTasks(["alpha", "beta"]);
    for (const action of ["complete", "remove", "update"]) {
      const text = (await h.tool({ action, task_id: "999" })).content[0].text;
      assert.match(text, /Task not found: 999/);
      assert.match(text, /#1 alpha/, `FIX: action '${action}' must list known refs so the caller can retry`);
      assert.match(text, /#2 beta/);
    }

    const after = await h.plan();
    assert.equal(after.length, 2, "unknown-ref ops must not mutate the plan");
    assert.deepEqual(after.map((t) => t.status), ["pending", "pending"]);
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────────── (5) state round-trip ─────────────────────────────
test("(5) tasks/status/refs survive session_shutdown + a fresh session (same id)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tplan-compat-rt-"));
  const sid = "sess-rt-9f3a";
  let h2;
  try {
    const h1 = await createHarness({ cwd: dir, sessionId: sid });
    await h1.addTasks(["first task", "second task"]);
    await h1.tool({ action: "complete", task_id: "1" });
    assert.deepEqual(await h1.statusByRef(), { 1: "done", 2: "pending" });
    await h1.stop(); // onSessionShutdown writes the shared plan file

    h2 = await createHarness({ cwd: dir, sessionId: sid }); // fresh session log, same cwd+id
    // Refs/status are stable handles: assert them by ref, not by display order
    // (adoption re-derives `order` from the plan file's section layout).
    assert.deepEqual(
      await h2.statusByRef(),
      { 1: "done", 2: "pending" },
      "FIX: a fresh session must adopt stable refs+statuses from the shared plan file"
    );
    const textsByRef = Object.fromEntries((await h2.plan()).map((t) => [t.ref, t.text]));
    assert.deepEqual(textsByRef, { 1: "first task", 2: "second task" });

    const sameId = u
      .parsePlanSessions(await h2.planFile())
      .map((s) => s.id)
      .filter((id) => id === sid);
    assert.equal(sameId.length, 1, "the same session id must be deduplicated, not written twice");
  } finally {
    if (h2) await h2.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
