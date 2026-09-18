/**
 * Garantiza que los peer deps usados por src/utils.ts sean resolubles antes de los
 * tests. Si el repo no tiene node_modules instalado, crea un stub mínimo de
 * @earendil-works/pi-tui (sólo las dos funciones que utils.ts importa).
 * node_modules/ está en .gitignore; con `npm i` se usa el paquete real.
 */
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "package.json"));

const STUB = [
  'export const truncateToWidth = (s, w, e = "…") => (s.length > w ? s.slice(0, Math.max(1, w - 1)) + e : s);',
  'export const visibleWidth = (s) => [...String(s)].length;',
  'export const Key = { ctrlAlt: (k) => `ctrl+alt+${k}` };',
  '// Minimal stand-ins for the settings dialog used by /t-plan config.',
  'class Container {',
  '  children = [];',
  '  addChild(c) { this.children.push(c); }',
  '  render(width) { return this.children.flatMap((c) => c.render?.(width) ?? []); }',
  '  invalidate() { this.children.forEach((c) => c.invalidate?.()); }',
  '}',
  'class Text { constructor(t) { this.text = t; } render() { return [this.text]; } invalidate() {} }',
  'class SelectList { constructor(items) { this.items = items; } render() { return this.items.map((i) => i.label); } handleInput() {} invalidate() {} }',
  'class SettingsList { constructor(items) { this.items = items; } render(width) { return this.items.map((i) => "  " + i.label + "  [" + i.currentValue + "]"); } handleInput() {} invalidate() {} }',
  'export { Container, Text, SelectList, SettingsList };',
].join("\n");

/** Real pi-tui has these exports; a bare stub does not, so refresh it. */
async function stubIsComplete() {
  try {
    const src = await readFile(join(repoRoot, "node_modules", "@earendil-works", "pi-tui", "index.js"), "utf-8");
    return /SettingsList/.test(src);
  } catch {
    return false;
  }
}

/**
 * `npm install` of a peerDependency can leave a partially-written package folder
 * (no real exports). Detect that and replace it with the stub, otherwise every
 * import of pi-tui fails on missing names.
 */
async function realPiTuiIsUsable() {
  try {
    const mod = await import("@earendil-works/pi-tui");
    return typeof mod.truncateToWidth === "function" && typeof mod.Key === "object";
  } catch {
    return false;
  }
}

export async function ensurePeers() {
  let installed = false;
  try {
    require.resolve("@earendil-works/pi-tui");
    installed = true;
  } catch {
    // no instalado: stub
  }
  if (installed && await realPiTuiIsUsable()) return;

  // The folder may hold a broken half-installed package: overwrite it with the stub.
  const dir = join(repoRoot, "node_modules", "@earendil-works", "pi-tui");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0", type: "module", main: "index.js" }, null, 2)
  );
  await writeFile(join(dir, "index.js"), STUB);
}
