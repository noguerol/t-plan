import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

let u;

before(async () => {
  await ensurePeers();
  u = await import("../src/utils.ts");
});

// ── assignRefs: stable and unique, even for a hand-edited file ──────────────────
test("assignRefs deduplicates repeated refs without renumbering unique ones", () => {
  const tasks = [
    { id: "a", ref: 1, text: "a", status: "pending", order: 1 },
    { id: "b", ref: 1, text: "b", status: "pending", order: 2 },
    { id: "c", ref: 0, text: "c", status: "pending", order: 3 },
  ];
  u.assignRefs(tasks);
  assert.deepEqual(tasks.map((t) => t.ref), [1, 2, 3]);
});

test("assignRefs keeps unique refs and fills gaps after the maximum", () => {
  const tasks = [
    { id: "a", ref: 5, text: "a", status: "pending", order: 1 },
    { id: "b", ref: 0, text: "b", status: "pending", order: 2 },
    { id: "c", ref: 5, text: "c", status: "pending", order: 3 },
  ];
  u.assignRefs(tasks);
  assert.deepEqual(tasks.map((t) => t.ref), [5, 6, 7]);
});

// ── CRLF plan files (Windows editors) must not silently lose tasks/sessions ─────
test("extractPlanTasks parses a CRLF plan file", () => {
  const md =
    "# p Plan\r\n\r\n## ✅ Completed\r\n\r\n- [x] #1. done thing (took 00:00:03) (→ t2)\r\n\r\n## ⏳ Pending\r\n\r\n- [ ] #2. pending thing\r\n";
  const tasks = u.extractPlanTasks(md);
  assert.equal(tasks.length, 2);
  const done = tasks.find((t) => t.text.includes("done thing"));
  const pending = tasks.find((t) => t.text.includes("pending thing"));
  assert.equal(done.ref, 1);
  assert.equal(done.status, "done");
  assert.equal(done.tier, "t2");
  assert.equal(pending.ref, 2);
});

test("parsePlanSessions parses a CRLF Sessions section", () => {
  const md =
    "## 🗂 Sessions\r\n\r\n- `aa` — first seen 2026-01-01 00:00:00, last seen 2026-01-01 01:00:00\r\n";
  const sessions = u.parsePlanSessions(md);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "aa");
});

// ── Runtime: purge and load must target the unified project file ────────────────
async function projectDir(name) {
  return join(await mkdtemp(join(tmpdir(), "tplan-qa-")), name);
}

test("purge removes the unified project file and tolerates a missing one", async () => {
  const h = await createHarness();
  try {
    await h.addTasks(["task to purge"]);
    assert.equal((await h.planFiles()).length, 1);

    await h.rt.tPlanCommand.handler("purge", h.ctx);
    assert.deepEqual(await h.planFiles(), [], "purge removes the real unified file");
    await h.rt.tPlanCommand.handler("purge", h.ctx); // already gone: must not throw
  } finally {
    await h.cleanup();
  }
});

test("/t-plan load adopts a legacy file and migrates it to the unified name", async () => {
  const cwd = await projectDir("loadproj");
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "plan_other_01a0aaaa.md"),
    "# other Plan\n\n## ⏳ Pending\n\n- [ ] #1. loaded task from legacy\n",
    "utf-8"
  );

  const h = await createHarness({ cwd, sessionId: "sessLOAD" });
  try {
    h.ctx.ui.select = async () => "1";
    await h.rt.tPlanCommand.handler("load", h.ctx);

    const files = (await readdir(cwd)).filter((f) => f.endsWith(".md")).sort();
    assert.deepEqual(files, ["plan_other.md"], "loaded legacy file becomes the unified file");
    const list = (await h.tool({ action: "list" })).content[0].text;
    assert.match(list, /loaded task from legacy/);
  } finally {
    await h.cleanup();
  }
  await rm(cwd, { recursive: true, force: true });
});

// ── Regresión QA: con trimegisto activo, `displayState` es una copia y se
// construía antes del merge, así que la sesión ajena nunca llegaba al disco. ────
test("trimegisto mode: a foreign session is merged into the file written in the same pass", async () => {
  const h = await createHarness({ sessionId: "sessHOST" });
  try {
    // Enable trimegisto through the config menu (label when currently OFF).
    const realSelect = h.ctx.ui.select;
    h.ctx.ui.select = async () => "❌ TG: OFF";
    await h.rt.tPlanCommand.handler("config", h.ctx);
    h.ctx.ui.select = realSelect;

    await h.addTasks(["host task one"]);
    const file = join(h.cwd, (await h.planFiles())[0]);
    await new Promise((r) => setTimeout(r, 30));
    const disk = await readFile(file, "utf-8");
    const other = "- `sessOTHER` — first seen 2026-01-01 00:00:00, last seen 2026-01-01 01:00:00";
    await writeFile(file, disk.replace(/(\n## [^\n]*Sessions\n)/, `$1\n${other}\n`), "utf-8");

    await h.addTasks(["host task two"]);
    const after = await readFile(file, "utf-8");
    assert.match(after, /sessOTHER/, "trimegisto mode must serialize the merged session in the same write");
  } finally {
    await h.cleanup();
  }
});

// ── Regresión QA: dos sesiones que escriben en el mismo milisegundo. La guarda
// usaba `mtimeMs > lastPlanMtime + 1` y no detectaba la escritura ajena. ──────────
test("fast consecutive writes from two sessions still merge both histories", async () => {
  for (let i = 0; i < 5; i++) {
    const cwd = join(await mkdtemp(join(tmpdir(), "tplan-race-")), "proj");
    await mkdir(cwd, { recursive: true });
    const h1 = await createHarness({ cwd, sessionId: "sessA" });
    const h2 = await createHarness({ cwd, sessionId: "sessB" });
    try {
      await h1.addTasks(["from A"]);
      await h2.addTasks(["from B"]);
      await h1.addTasks(["from A again"]);
      const md = await readFile(join(cwd, "plan_proj.md"), "utf-8");
      const sessions = u.parsePlanSessions(md);
      assert.ok(
        sessions.some((s) => s.id === "sessA") && sessions.some((s) => s.id === "sessB"),
        `iteration ${i}: both sessions must survive fast consecutive writes (got ${sessions.map((s) => s.id).join(",")})`
      );
    } finally {
      await h2.cleanup();
      await h1.cleanup();
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
