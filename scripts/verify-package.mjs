#!/usr/bin/env node
// Verify the extension is loadable exactly as pi loads it (entry from package.json "pi").
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const entry = pkg.pi?.extensions?.[0];
if (!entry) {
  console.error("FAIL: package.json has no pi.extensions entry");
  process.exit(1);
}
const target = entry.startsWith("./") ? entry.slice(2) : entry;
if (!readdirSync("src").includes(target.split("/")[1] || target)) {
  console.error(`FAIL: entry ${target} not present in src/`);
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--eval", `import ext from "./${target}"; console.log("extension exported:", typeof ext)`],
  { encoding: "utf8" },
);
if (res.status !== 0) {
  console.error("FAIL: entry point does not load:", res.stderr);
  process.exit(1);
}
console.log("OK:", entry, "loads as pi expects");
