import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

/** Directorio de proyecto con nombre estable (el título auto sale de su basename). */
async function projectDir(name) {
  return join(await mkdtemp(join(tmpdir(), "tplan-proj-")), name);
}

test("una sola plan_<slug>.md y continuidad entre sesiones", async () => {
  const cwd = await projectDir("myapp");
  await mkdir(cwd, { recursive: true });

  const h1 = await createHarness({ cwd, sessionId: "sessA001aaa" });
  await h1.addTasks(["Add JWT auth in src/auth.ts", "Write tests for /login"]);
  await h1.tool({ action: "complete", task_id: "1" });
  await h1.cleanup(); // escribe el fichero y conserva cwd

  assert.deepEqual(await h1.planFiles(), ["plan_myapp.md"], "una única plan_myapp.md, sin id de sesión");

  const h2 = await createHarness({ cwd, sessionId: "sessB002bbb" });
  try {
    const list = (await h2.tool({ action: "list" })).content[0].text;
    assert.match(list, /✅\s*#1\. Add JWT auth in src\/auth\.ts/, "la sesión B adopta la tarea 1 con su ref y estado");
    assert.match(list, /⏳\s*#2\. Write tests for \/login/, "la sesión B adopta la tarea 2 con su ref y estado");
  } finally {
    await h2.cleanup();
  }

  assert.deepEqual(await h2.planFiles(), ["plan_myapp.md"], "la sesión B no crea copias");

  const md = await readFile(join(cwd, "plan_myapp.md"), "utf-8");
  assert.match(md, /## .*Sessions/, "el fichero lleva sección de sesiones");
  assert.match(md, /sessA001aaa/, "registra la sesión A");
  assert.match(md, /sessB002bbb/, "registra la sesión B");

  await rm(cwd, { recursive: true, force: true });
});

test("un fichero legacy session-scoped se adopta por rename, no se duplica", async () => {
  const cwd = await projectDir("legacyapp");
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "plan_legacyapp_01a0aaaa.md"),
    [
      "# legacyapp Plan",
      "",
      "## ✅ Completed",
      "",
      "- [x] #1. Old done task",
      "",
      "## ⏳ Pending",
      "",
      "- [ ] #2. Old pending task",
      "",
    ].join("\n"),
    "utf-8"
  );

  const h = await createHarness({ cwd, sessionId: "brandnew01" });
  try {
    assert.deepEqual(await h.planFiles(), ["plan_legacyapp.md"], "el legacy pasa a ser el fichero unificado");
    await assert.rejects(access(join(cwd, "plan_legacyapp_01a0aaaa.md")), "el fichero con id de sesión desaparece");

    const list = (await h.tool({ action: "list" })).content[0].text;
    assert.match(list, /✅\s*#1\. Old done task/, "ref y estado se conservan al adoptar");
    assert.match(list, /⏳\s*#2\. Old pending task/, "ref y estado se conservan al adoptar");
  } finally {
    await h.cleanup();
  }

  await rm(cwd, { recursive: true, force: true });
});
