// Adversarial QA by execution: the foreign-write concurrency guard + the unified
// plan file (src/runtime.ts + src/utils.ts).
//
// Owns ONLY this file. It never modifies src/ or any other test. Every test uses
// the shared harness (tests/helpers/harness.mjs) with a temp HOME and temp cwd, so
// no real project file or user config is ever read or written.
//
// One test per hypothesis (1)-(12); each was first observed failing/passing by
// execution, not by reading. Failing tests are kept as evidence.

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

/** Name of the unified plan file the runtime writes in the harness cwd. */
async function planFileName(h) {
  const names = await h.planFiles();
  const name = names.find((n) => n.startsWith("plan_") && n.endsWith(".md"));
  assert.ok(name, `expected a plan_*.md file, got ${JSON.stringify(names)}`);
  return name;
}

const sessionLine = (id, first = "2026-01-01 00:00:00", last = "2026-01-02 00:00:00") =>
  `- \`${id}\` — first seen ${first}, last seen ${last}`;

function foreignPlanWithLines(title, task, lines) {
  return [
    `# ${title}`,
    "",
    "## ⏳ Pending",
    "",
    `- [ ] #1. ${task}`,
    "",
    "## 🗂 Sessions",
    "",
    ...lines,
    "",
  ].join("\n");
}

function foreignPlan(title, task, ids) {
  return foreignPlanWithLines(title, task, ids.map((id) => sessionLine(id)));
}

/** Session bullets actually present in a plan file (task bullets are `- [ ]`/`- [x]`). */
const sessionBullets = (content) => content.split(/\r?\n/).filter((l) => /^\s*-\s+`/.test(l));
const sessionIds = (content) =>
  sessionBullets(content)
    .map((l) => l.match(/`([^`]+)`/)?.[1])
    .filter(Boolean);

// ── (1) trimegisto mode must not drop the merged foreign sessions ──────────────
// writePlanFile shallow-copies state into displayState when config.trimegisto is
// on. If that copy is taken BEFORE mergeSessionsIntoState reassigns state.sessions,
// the foreign id reaches the file only by accident. This test enables TG for real
// (config menu), proves TG is on, then forces a foreign write.
test("(1) trimegisto mode: foreign session history survives the very next write", async () => {
  const h = await createHarness({ sessionId: "ownTG00001" });
  try {
    await h.addTasks(["first"]);
    const name = await planFileName(h);

    // Enable trimegisto through the real config menu (same path a user takes).
    h.ctx.ui.select = async () => "❌ TG: OFF";
    await h.rt.tPlanCommand.handler("config", h.ctx);

    // Prove TG is actually ON, otherwise this test would be vacuous: with TG off
    // displayState === state and the bug cannot manifest.
    const start = await h.runStart();
    assert.ok(
      start?.message?.content?.includes("[TG]"),
      "sanity: trimegisto mode was not enabled"
    );

    await sleep(30);
    await writeFile(join(h.cwd, name), foreignPlan("TG Foreign", "foreign tg task", ["foreignTG42"]), "utf-8");

    h.notes.length = 0;
    // The hypothesis is specifically about the VERY NEXT write. A follow-up write
    // would pass even with the bug, because by then mergeSessionsIntoState has
    // already replaced state.sessions and the next displayState copy picks it up.
    // So assert on the file produced by exactly one write after the foreign one.
    await h.addTasks(["second"]); // detects + merges + writes (the very next write)
    const nextIds = sessionIds(await h.planFile());

    // Diagnostic only: prove whether the foreign id only shows up on a later write.
    await h.addTasks(["flush"]);
    const laterIds = sessionIds(await h.planFile());

    assert.ok(
      nextIds.includes("foreignTG42"),
      `H1 FAIL: the very next write dropped the foreign session. ` +
        `next=[${nextIds.join(", ")}] later=[${laterIds.join(", ")}] ` +
        `→ displayState is snapshotted before mergeSessionsIntoState reassigns state.sessions.`
    );
    assert.ok(
      nextIds.includes("ownTG00001"),
      `own session lost in TG mode: [${nextIds.join(", ")}]`
    );
  } finally {
    await h.cleanup();
  }
});

// ── (2) first write to a fresh path never warns ────────────────────────────────
test("(2) first write to a fresh path never warns", async () => {
  const h = await createHarness({ sessionId: "fresh00001" });
  try {
    h.notes.length = 0;
    await h.addTasks(["first ever task"]);
    await h.addTasks(["second ever task"]);
    assert.equal(warns(h).length, 0, `unexpected warning on first write: ${msgs(h)}`);
  } finally {
    await h.cleanup();
  }
});

// ── (3) our own writes never self-warn (mtime tolerance) ───────────────────────
test("(3) our own writes never trigger a self-warning (mtime tolerance)", async () => {
  const h = await createHarness({ sessionId: "ownSelf0001" });
  try {
    h.notes.length = 0;
    for (let i = 0; i < 6; i++) await h.addTasks([`rapid ${i}`]);
    await h.tool({ action: "complete", task_id: "1" });
    await h.tool({ action: "start", task_id: "2" });
    await h.addTasks(["tail"]);
    assert.equal(warns(h).length, 0, `self-warning on our own writes: ${msgs(h)}`);
  } finally {
    await h.cleanup();
  }
});

// ── (4) title change ⇒ new file, no spurious warning ───────────────────────────
test("(4) changing the plan title does not warn on the new file", async () => {
  const h = await createHarness({ sessionId: "titleChg001" });
  try {
    await h.addTasks(["before retitle"]);
    const oldName = await planFileName(h);
    assert.ok(oldName.startsWith("plan_"), oldName);

    // Retitle to a different project (new slug ⇒ new file path).
    h.ctx.ui.input = async () => "Brand New Project";
    await h.rt.tPlanCommand.handler("new", h.ctx);

    // Adversarial: the new file already exists and is newer than anything we wrote.
    const newName = "plan_brand-new-project.md";
    await writeFile(
      join(h.cwd, newName),
      foreignPlan("Brand New Project", "foreign new title task", ["foreignTitle"]),
      "utf-8"
    );
    await sleep(30);

    h.notes.length = 0;
    await h.addTasks(["after retitle"]);
    await h.addTasks(["flush"]);

    assert.equal(warns(h).length, 0, `spurious warning after title change: ${msgs(h)}`);
    const final = await readFile(join(h.cwd, newName), "utf-8");
    assert.ok(final.includes("after retitle"), "the post-retitle task must be written to the new file");
  } finally {
    await h.cleanup();
  }
});

// ── (5) file-prefix change ⇒ new file, no spurious warning ─────────────────────
test("(5) changing the file prefix does not warn on the new file", async () => {
  const h = await createHarness({ sessionId: "prefixChg01" });
  try {
    await h.addTasks(["before prefix"]);
    const oldName = await planFileName(h);
    const slug = oldName.slice("plan_".length);

    // Change the prefix through the real config menu.
    h.ctx.ui.select = async () => "📄 Prefix: plan";
    h.ctx.ui.input = async () => "myplan";
    await h.rt.tPlanCommand.handler("config", h.ctx);

    const newName = `myplan_${slug}`;
    await writeFile(
      join(h.cwd, newName),
      foreignPlan("Foreign Prefix", "foreign prefix task", ["foreignPrefix"]),
      "utf-8"
    );
    await sleep(30);

    h.notes.length = 0;
    await h.addTasks(["after prefix"]);
    await h.addTasks(["flush"]);

    assert.equal(warns(h).length, 0, `spurious warning after prefix change: ${msgs(h)}`);
    const names = await h.planFiles();
    assert.ok(names.includes(newName), `expected ${newName}, got ${JSON.stringify(names)}`);
    const final = await readFile(join(h.cwd, newName), "utf-8");
    assert.ok(final.includes("after prefix"), "the post-prefix task must be written to the new file");
  } finally {
    await h.cleanup();
  }
});

// ── (6) the reset command clears tracking ⇒ a recreated file is not foreign ────
test("(6) purge resets tracking so a later write does not warn", async () => {
  const h = await createHarness({ sessionId: "resetPurge1" });
  try {
    await h.addTasks(["before purge"]);
    const name = await planFileName(h);
    await h.rt.tPlanCommand.handler("purge", h.ctx); // confirm() defaults to true

    // Another session recreates the shared file with a newer mtime.
    await sleep(30);
    await writeFile(join(h.cwd, name), foreignPlan("Purge Plan", "post purge foreign", ["foreignPurge"]), "utf-8");

    h.notes.length = 0;
    await h.addTasks(["after purge"]);
    await h.addTasks(["flush"]);

    assert.equal(warns(h).length, 0, `spurious warning after purge: ${msgs(h)}`);
    assert.ok((await h.planFile()).includes("after purge"), "the post-purge task is written");
  } finally {
    await h.cleanup();
  }
});

// ── (7) one foreign write ⇒ exactly one warning ────────────────────────────────
test("(7) the foreign-write warning is emitted exactly once", async () => {
  const h = await createHarness({ sessionId: "once000001" });
  try {
    await h.addTasks(["base"]);
    const name = await planFileName(h);

    await sleep(30);
    await writeFile(join(h.cwd, name), foreignPlan("Foreign Once", "foreign once", ["foreignOnce1"]), "utf-8");

    h.notes.length = 0;
    for (let i = 0; i < 5; i++) await h.addTasks([`poll ${i}`]);

    assert.equal(warns(h).length, 1, `expected exactly one warning, got ${warns(h).length}: ${msgs(h)}`);
  } finally {
    await h.cleanup();
  }
});

// ── (8) a CRLF foreign write still merges its sessions ─────────────────────────
test("(8) a foreign write with CRLF line endings still merges sessions", async () => {
  const h = await createHarness({ sessionId: "crlf000001" });
  try {
    await h.addTasks(["base crlf"]);
    const name = await planFileName(h);

    const crlf = foreignPlan("CRLF Foreign", "crlf task", ["crlfSess42"]).split("\n").join("\r\n");
    // The parser itself must read CRLF.
    assert.deepEqual(
      u.parsePlanSessions(crlf).map((s) => s.id),
      ["crlfSess42"],
      "parsePlanSessions must handle CRLF"
    );

    await sleep(30);
    await writeFile(join(h.cwd, name), crlf, "utf-8");

    h.notes.length = 0;
    await h.addTasks(["after crlf"]);
    await h.addTasks(["flush"]);

    const final = await h.planFile();
    assert.ok(sessionIds(final).includes("crlfSess42"), "CRLF foreign session must survive the merge");
    assert.ok(sessionIds(final).includes("crlf000001"), "our own session must remain");
  } finally {
    await h.cleanup();
  }
});

// ── (9) malformed/empty Sessions section: no crash, no state corruption ────────
test("(9) malformed/empty Sessions section does not crash or corrupt state", async () => {
  const h = await createHarness({ sessionId: "malformed01" });
  try {
    await h.addTasks(["keep me"]);
    const name = await planFileName(h);

    const malformed = foreignPlanWithLines("Malformed", "foreign malformed", [
      "this line is not a session at all",
      "- `` broken backticks",
      "- `no stamps here`",
    ]);
    assert.deepEqual(u.parsePlanSessions(malformed), [], "malformed lines must be ignored");

    await sleep(30);
    await writeFile(join(h.cwd, name), malformed, "utf-8");
    h.notes.length = 0;
    await h.addTasks(["after malformed"]); // must not throw
    await h.addTasks(["flush"]);

    // Now an empty Sessions section too.
    await sleep(30);
    await writeFile(join(h.cwd, name), foreignPlanWithLines("Empty Sect", "foreign empty", []), "utf-8");
    await h.addTasks(["after empty"]); // must not throw
    await h.addTasks(["flush"]);

    const final = await h.planFile();
    assert.ok(final.includes("keep me"), "our task state must survive a malformed foreign write");
    assert.ok(sessionIds(final).includes("malformed01"), "our own session must survive");
    assert.ok(!final.includes("this line is not a session"), "garbage must not be copied into the file");
    assert.ok(u.extractPlanTasks(final).length >= 1, "the file must remain parseable");
  } finally {
    await h.cleanup();
  }
});

// ── (10) >20 foreign sessions: capped at 20 and deduped ────────────────────────
test("(10) more than 20 foreign sessions are capped at 20 and deduped", async () => {
  const h = await createHarness({ sessionId: "cap0000001" });
  try {
    await h.addTasks(["base cap"]);
    const name = await planFileName(h);

    const lines = [];
    for (let i = 0; i < 25; i++) {
      const ss = String(i).padStart(2, "0");
      lines.push(sessionLine(`foreignCap${ss}`, "2026-01-01 00:00:00", `2026-01-01 00:00:${ss}`));
    }
    // Same id as foreignCap05 but newest: must appear exactly once and survive the cap.
    lines.push(sessionLine("foreignCap05", "2025-12-01 00:00:00", "2026-06-01 00:00:00"));

    await sleep(30);
    await writeFile(join(h.cwd, name), foreignPlanWithLines("Cap Plan", "cap task", lines), "utf-8");

    h.notes.length = 0;
    await h.addTasks(["after cap"]);
    await h.addTasks(["flush"]);

    const final = await h.planFile();
    const bullets = sessionBullets(final);
    const ids = sessionIds(final);
    assert.ok(bullets.length <= 20, `sessions must be capped at 20, got ${bullets.length}`);
    assert.equal(ids.length, bullets.length, "every session bullet must have a distinct id");
    assert.equal(new Set(ids).size, ids.length, `deduped ids expected, got [${ids.join(", ")}]`);
    assert.equal(ids.filter((id) => id === "foreignCap05").length, 1, "duplicate foreign id must collapse to one");
  } finally {
    await h.cleanup();
  }
});

// ── (11) two interleaved runtimes on one cwd: file stays parseable, both ids ───
test("(11) two interleaved runtimes keep the file parseable with both sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tplan-shared-"));
  const h1 = await createHarness({ cwd: dir, sessionId: "interleave01" });
  const h2 = await createHarness({ cwd: dir, sessionId: "interleave02" });
  try {
    await h1.addTasks(["one from A"]);
    await sleep(30);
    await h2.addTasks(["two from B"]);
    await sleep(30);
    await h1.addTasks(["three from A"]);
    await sleep(30);
    await h2.addTasks(["four from B"]);

    const names = (await h2.planFiles()).filter((n) => n.startsWith("plan_") && n.endsWith(".md"));
    assert.equal(names.length, 1, `exactly one unified file expected, got ${JSON.stringify(names)}`);
    const final = await readFile(join(dir, names[0]), "utf-8");

    // Parseable: real tasks and sessions, valid header.
    assert.ok(/^#\s+\S/m.test(final), "file must have a title header");
    assert.ok(u.extractPlanTasks(final).length >= 1, "file must contain parseable tasks");
    const ids = u.parsePlanSessions(final).map((s) => s.id);
    assert.ok(ids.includes("interleave01"), `runtime A session missing: [${ids.join(", ")}]`);
    assert.ok(ids.includes("interleave02"), `runtime B session missing: [${ids.join(", ")}]`);
  } finally {
    await h2.cleanup();
    await h1.cleanup();
    process.env.HOME = ORIG_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── (12) adoptPlanContent is awaited on every call path ────────────────────────
test("(12) adoptPlanContent is awaited by every caller (no un-awaited async path)", async () => {
  const src = await readFile(new URL("../src/runtime.ts", import.meta.url), "utf-8");
  const lines = src.split(/\r?\n/);

  const calls = [];
  lines.forEach((line, i) => {
    if (!/\badoptPlanContent\s*\(/.test(line)) return;
    if (/async\s+function\s+adoptPlanContent\s*\(/.test(line)) return; // definition
    calls.push({ n: i + 1, line });
  });
  assert.ok(calls.length >= 1, "expected at least one adoptPlanContent call site");

  for (const { n, line } of calls) {
    const awaited = /\bawait\s+adoptPlanContent\s*\(/.test(line);
    const returned = /^\s*return\s+adoptPlanContent\s*\(/.test(line);
    assert.ok(awaited || returned, `line ${n}: adoptPlanContent called without await/return: ${line.trim()}`);
    if (returned) {
      // The enclosing function must be async so the promise is propagated.
      let decl;
      for (let j = n - 2; j >= 0 && j > n - 2 - 60; j--) {
        if (/function\s+\w+\s*\(/.test(lines[j])) {
          decl = lines[j];
          break;
        }
      }
      assert.ok(decl, `line ${n}: could not find enclosing function`);
      assert.ok(/async/.test(decl), `line ${n}: enclosing function is not async: ${decl.trim()}`);
    }
  }

  // And every readPlanFile call must be awaited too.
  lines.forEach((line, i) => {
    if (!/\breadPlanFile\s*\(/.test(line)) return;
    if (/function\s+readPlanFile\s*\(/.test(line)) return;
    assert.ok(
      /\bawait\s+readPlanFile\s*\(/.test(line) || /return\s+readPlanFile\s*\(/.test(line),
      `readPlanFile call not awaited at line ${i + 1}: ${line.trim()}`
    );
  });
});
