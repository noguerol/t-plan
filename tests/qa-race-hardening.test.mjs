// Adversarial edge-case QA by execution of the HARDENED foreign-write concurrency
// guard (src/runtime.ts: lastPlanMtime / pendingForeignWrite / mergeSessionsIntoState).
//
// Owns ONLY this file. It never modifies src/ or any other test. Every test uses the
// shared harness (tests/helpers/harness.mjs) with a temp HOME and a temp cwd, so no
// real project file and no user config is ever touched.
//
// One test per hypothesis (1)-(10). Each hypothesis is checked by *execution* and the
// result is reported by the test runner. A failing test is kept as evidence and the
// minimal source fix is described in its failure message (src/ is never edited here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();
const u = await import("../src/utils.ts");

const ORIG_HOME = process.env.HOME;
const WARN = "plan file was updated by another session";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warns = (h) => h.notes.filter((n) => String(n.msg).includes(WARN));
const msgs = (h) => JSON.stringify(h.notes.map((n) => n.msg));

/** The one (or explicitly named) `plan_*.md` / `<prefix>_*.md` file in the harness cwd. */
async function planName(h, expected) {
  const names = (await h.planFiles()).filter((n) => n.endsWith(".md"));
  if (expected) {
    assert.ok(names.includes(expected), `expected ${expected} among ${JSON.stringify(names)}`);
    return expected;
  }
  assert.equal(names.length, 1, `expected exactly one plan file, got ${JSON.stringify(names)}`);
  return names[0];
}

const sessionLine = (id, first = "2026-01-01 00:00:00", last = "2026-01-02 00:00:00") =>
  `- \`${id}\` — first seen ${first}, last seen ${last}`;

/** A valid plan file whose Sessions section advertises the given session ids. */
function foreignPlan(title, task, ids) {
  return [
    `# ${title}`,
    "",
    "## ⏳ Pending",
    "",
    `- [ ] #1. ${task}`,
    "",
    "## 🗂 Sessions",
    "",
    ...ids.map((id) => sessionLine(id)),
    "",
  ].join("\n");
}

const sessionIds = (content) => u.parsePlanSessions(content).map((s) => s.id);
const sessionBullets = (content) =>
  content.split(/\r?\n/).filter((l) => /^\s*-\s+`/.test(l));

// ── (1) NO self-warning: our own consecutive writes never look foreign ──────────
// Guards against the strict `>` mtime comparison (post-write stat) mis-firing on
// our own writes. If it did, the user would be warned on every other write.
test("(1) 15 consecutive normal writes never emit a self-warning", async () => {
  const h = await createHarness({ sessionId: "selfRace001" });
  try {
    await h.addTasks(["seed"]);
    h.notes.length = 0;
    for (let i = 0; i < 15; i++) {
      if (i % 2 === 0) await h.addTasks([`self write ${i}`]);
      else await h.tool({ action: "complete", task_id: "1" }); // idempotent, still a write
    }
    // Sanity: the writes really happened (seed + 8 adds), so "no warning" is not vacuous.
    assert.equal((await h.plan()).length, 9, "expected seed + 8 added tasks to be persisted");
    assert.equal(
      warns(h).length,
      0,
      `H1 FAIL: our own writes self-warned ${warns(h).length} time(s): ${msgs(h)}. ` +
        `Minimal fix: compare with a tolerance / record mtime before the write too, in writePlanFile().`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (2) the /t-plan load adopt path records the adopted file's mtime ────────────
// After adopting a file, the next normal write must not consider it foreign.
test("(2) after adopting a file via the load path, the next normal write does not warn", async () => {
  const h = await createHarness({ sessionId: "loadAdopt01" });
  try {
    // Created AFTER session start, so it is adopted through the explicit load path,
    // not through the onSessionStart readPlanFile path.
    await writeFile(
      join(h.cwd, "plan_loaded-project_01a0aaaa.md"),
      foreignPlan("Loaded Project", "loaded task", ["foreignLoad1"]),
      "utf-8"
    );

    h.ctx.ui.select = async () => "1";
    await h.rt.tPlanCommand.handler("load", h.ctx);

    const unified = u.planFileNameFor("plan", "Loaded Project");
    await planName(h, unified); // load migrated the legacy file to the unified name

    h.notes.length = 0;
    await h.addTasks(["after load"]);
    await h.addTasks(["flush"]);
    assert.equal(
      warns(h).length,
      0,
      `H2 FAIL: load adopt did not record lastPlanMtime, next write warned: ${msgs(h)}. ` +
        `Minimal fix: adoptPlanContent() must set lastPlanMtime from the adopted file (it does for readPlanFile).`
    );
    const final = await readFile(join(h.cwd, unified), "utf-8");
    assert.ok(final.includes("after load"), "the post-load task must be written");
  } finally {
    await h.cleanup();
  }
});

// ── (3) reset (purge) clears tracking, then a real foreign write is still caught ─
test("(3) purge resets tracking; a later real foreign write is still detected and warns", async () => {
  const h = await createHarness({ sessionId: "resetRace01" });
  try {
    await h.addTasks(["one"]);
    const name = await planName(h);
    await h.rt.tPlanCommand.handler("purge", h.ctx); // deletes file, lastPlanMtime = undefined
    assert.deepEqual(await h.planFiles(), [], "purge removes the project file");

    // Reset worked: re-establishing the baseline must NOT be flagged.
    h.notes.length = 0;
    await h.addTasks(["two"]);
    const afterReset = await planName(h);
    assert.equal(afterReset, name, "the auto title resolves to the same project file");
    assert.equal(
      warns(h).length,
      0,
      `H3 FAIL (a): the reset itself produced a spurious warning: ${msgs(h)}`
    );

    // A genuine foreign write after the reset must be detected again.
    await sleep(30);
    await writeFile(
      join(h.cwd, afterReset),
      foreignPlan("Reset Race", "foreign reset task", ["foreignReset1"]),
      "utf-8"
    );
    await h.addTasks(["three"]);
    await h.addTasks(["flush"]);

    assert.ok(
      warns(h).length >= 1,
      `H3 FAIL (b): foreign write after reset was not detected: ${msgs(h)}. ` +
        `Minimal fix: purge must not permanently disable the guard — it must only clear lastPlanMtime.`
    );
    const final = await readFile(join(h.cwd, afterReset), "utf-8");
    assert.ok(sessionIds(final).includes("foreignReset1"), "foreign session must be merged");
    assert.ok(sessionIds(final).includes("resetRace01"), "own session must remain");
  } finally {
    await h.cleanup();
  }
});

// ── (4) title change: detection still works on the new file ─────────────────────
test("(4) title change then a foreign write on the new file is still detected", async () => {
  const h = await createHarness({ sessionId: "titleRace01" });
  try {
    await h.addTasks(["before retitle"]);

    h.ctx.ui.input = async () => "Race New Title";
    await h.rt.tPlanCommand.handler("new", h.ctx); // tasks cleared, tracking reset

    // Our own write to the NEW path establishes its baseline.
    await h.addTasks(["baseline on new file"]);
    const newName = u.planFileNameFor("plan", "Race New Title");
    await planName(h, newName);

    await sleep(30);
    await writeFile(
      join(h.cwd, newName),
      foreignPlan("Race New Title", "foreign new title task", ["foreignTitle1"]),
      "utf-8"
    );

    h.notes.length = 0;
    await h.addTasks(["after retitle foreign"]);
    await h.addTasks(["flush"]);

    assert.ok(
      warns(h).length >= 1,
      `H4 FAIL: foreign write on the retitled file was not detected: ${msgs(h)}`
    );
    const final = await readFile(join(h.cwd, newName), "utf-8");
    assert.ok(sessionIds(final).includes("foreignTitle1"), "foreign session must be merged on the new file");
    assert.ok(final.includes("after retitle foreign"), "our task must be written");
  } finally {
    await h.cleanup();
  }
});

// ── (5) prefix change: normal writes on the new prefix never warn ───────────────
test("(5) prefix change then normal writes do not warn", async () => {
  const h = await createHarness({ sessionId: "prefixRace01" });
  try {
    await h.addTasks(["before prefix"]);
    const oldName = await planName(h);
    const slug = oldName.slice("plan_".length);

    h.ctx.ui.select = async () => "📄 Prefix: plan";
    h.ctx.ui.input = async () => "myplan";
    await h.rt.tPlanCommand.handler("config", h.ctx);

    const newName = `myplan_${slug}`;
    h.notes.length = 0;
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) await h.addTasks([`prefix write ${i}`]);
      else await h.tool({ action: "complete", task_id: "1" });
    }
    assert.equal(
      warns(h).length,
      0,
      `H5 FAIL: prefix change produced a spurious warning: ${msgs(h)}. ` +
        `Minimal fix: config prefix change already resets lastPlanMtime in showConfigMenu().`
    );
    await planName(h, newName);
    const final = await readFile(join(h.cwd, newName), "utf-8");
    assert.ok(final.includes("prefix write"), "writes must land on the new-prefix file");
  } finally {
    await h.cleanup();
  }
});

// ── (6) trimegisto mode: no false positives, same-pass foreign merge ────────────
test("(6) trimegisto: 10 normal writes never warn and a foreign write merges in the same pass", async () => {
  const h = await createHarness({ sessionId: "ownTGrace01" });
  try {
    await h.addTasks(["seed tg"]);

    h.ctx.ui.select = async () => "❌ TG: OFF";
    await h.rt.tPlanCommand.handler("config", h.ctx);

    const start = await h.runStart();
    assert.ok(start?.message?.content?.includes("[TG]"), "sanity: trimegisto was not enabled");

    h.notes.length = 0;
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) await h.addTasks([`tg write ${i}`]);
      else await h.tool({ action: "complete", task_id: "1" });
    }
    assert.equal(warns(h).length, 0, `H6 FAIL (a): TG normal writes warned: ${msgs(h)}`);

    const name = await planName(h);
    await sleep(30);
    await writeFile(
      join(h.cwd, name),
      foreignPlan("TG Race", "foreign tg race", ["foreignTGrace1"]),
      "utf-8"
    );

    await h.addTasks(["after tg foreign"]);
    const samePass = await readFile(join(h.cwd, name), "utf-8");
    const ids = sessionIds(samePass);
    assert.ok(
      ids.includes("foreignTGrace1"),
      `H6 FAIL (b): the same write dropped the foreign session: [${ids.join(", ")}]. ` +
        `Minimal fix: build displayState AFTER mergeSessionsIntoState() in writePlanFile().`
    );
    assert.ok(ids.includes("ownTGrace01"), `own session missing: [${ids.join(", ")}]`);

    await h.addTasks(["flush"]);
    assert.ok(warns(h).length >= 1, `H6 FAIL (c): TG foreign write did not warn: ${msgs(h)}`);
  } finally {
    await h.cleanup();
  }
});

// ── (7) identical bytes but a newer mtime is still treated as foreign ───────────
test("(7) identical content with a newer mtime is flagged and does not corrupt state", async () => {
  const h = await createHarness({ sessionId: "identRace01" });
  try {
    await h.addTasks(["base identical"]);
    const name = await planName(h);
    const identical = await readFile(join(h.cwd, name), "utf-8");

    h.notes.length = 0;
    await sleep(30);
    await writeFile(join(h.cwd, name), identical, "utf-8"); // same bytes, newer mtime

    await h.addTasks(["after identical"]);
    await h.addTasks(["flush"]);

    assert.ok(
      warns(h).length >= 1,
      `H7 FAIL: a newer-mtime identical write was not flagged: ${msgs(h)}. ` +
        `Minimal fix: writePlanFile() must trust the mtime (it does) — do not add content hashing.`
    );
    const final = await readFile(join(h.cwd, name), "utf-8");
    assert.ok(final.includes("after identical"), "own task must be written, state intact");
    assert.ok(u.extractPlanTasks(final).length >= 2, "all tasks must still parse");
    assert.ok(sessionIds(final).includes("identRace01"), "own session must remain");
  } finally {
    await h.cleanup();
  }
});

// ── (8) oversized foreign Sessions section: no crash, capped at 20 ──────────────
test("(8) an oversized foreign Sessions section (1000 entries) parses and is capped at 20", async () => {
  const h = await createHarness({ sessionId: "bigRace0001" });
  try {
    await h.addTasks(["base big"]);
    const name = await planName(h);

    const ids = Array.from({ length: 1000 }, (_, i) => `foreignBig${String(i).padStart(4, "0")}`);
    await sleep(30);
    await writeFile(join(h.cwd, name), foreignPlan("Big Race", "big foreign", ids), "utf-8");

    h.notes.length = 0;
    await h.addTasks(["after big"]); // must not throw
    await h.addTasks(["flush"]);

    const final = await readFile(join(h.cwd, name), "utf-8");
    const bullets = sessionBullets(final);
    assert.ok(
      bullets.length <= 20,
      `H8 FAIL: sessions were not capped at 20, got ${bullets.length}. ` +
        `Minimal fix: mergeSessionsIntoState()/generatePlanMarkdown() cap at 20 (they do).`
    );
    assert.ok(sessionIds(final).includes("bigRace0001"), "own session must remain");
    assert.ok(u.extractPlanTasks(final).some((t) => t.text.includes("after big")), "file must stay parseable");
    assert.ok(warns(h).length >= 1, "the foreign write must still be detected");
  } finally {
    await h.cleanup();
  }
});

// ── (9) two runtimes, 20 alternating writes: parseable, both sessions kept ──────
test("(9) two runtimes with 20 alternating writes keep the file parseable with both sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tplan-race-hard-"));
  const h1 = await createHarness({ cwd: dir, sessionId: "raceInterA1" });
  const h2 = await createHarness({ cwd: dir, sessionId: "raceInterB2" });
  try {
    for (let i = 0; i < 10; i++) {
      await h1.addTasks([`A write ${i}`]);
      await sleep(6);
      await h2.addTasks([`B write ${i}`]);
      await sleep(6);
    }

    const names = (await h1.planFiles()).filter((n) => n.endsWith(".md"));
    assert.equal(names.length, 1, `exactly one plan file expected, got ${JSON.stringify(names)}`);
    const final = await readFile(join(dir, names[0]), "utf-8");

    assert.ok(/^#\s+\S/m.test(final), "file must keep a title header");
    assert.ok(u.extractPlanTasks(final).length >= 1, "file must keep parseable tasks");
    const ids = sessionIds(final);
    assert.ok(
      ids.includes("raceInterA1") && ids.includes("raceInterB2"),
      `H9 FAIL: one runtime's session was lost: [${ids.join(", ")}]. ` +
        `Minimal fix: the strict > guard must still detect sub-ms/short-interval foreign writes (it does).`
    );
    assert.ok(sessionBullets(final).length <= 20, "session cap must be respected");
  } finally {
    await h2.cleanup();
    await h1.cleanup();
    process.env.HOME = ORIG_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── (10) zero tasks: writePlanFile is a no-op (no file, no warning) ─────────────
test("(10) writePlanFile no-ops with zero tasks (no file created, no warning)", async () => {
  const h = await createHarness({ sessionId: "zeroRace001" });
  try {
    assert.deepEqual(await h.planFiles(), [], "a fresh harness must not create a plan file");

    h.notes.length = 0;
    await h.rt.tPlanCommand.handler("save", h.ctx); // calls writePlanFile directly
    await h.rt.tPlanCommand.handler("save", h.ctx); // and again: still a no-op

    assert.deepEqual(
      await h.planFiles(),
      [],
      "H10 FAIL: writePlanFile created a file with zero tasks. " +
        "Minimal fix: keep the `state.tasks.length === 0` early return in writePlanFile()."
    );
    assert.equal(warns(h).length, 0, `H10 FAIL: zero-task save warned: ${msgs(h)}`);
  } finally {
    await h.cleanup();
  }
});
