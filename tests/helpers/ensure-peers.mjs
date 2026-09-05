/**
 * Garantiza que los peer deps usados por src/utils.ts sean resolubles antes de los
 * tests. Si el repo no tiene node_modules instalado, crea un stub mínimo de
 * @earendil-works/pi-tui (sólo las dos funciones que utils.ts importa).
 * node_modules/ está en .gitignore; con `npm i` se usa el paquete real.
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(repoRoot, "package.json"));

export async function ensurePeers() {
  try {
    require.resolve("@earendil-works/pi-tui");
    return;
  } catch {
    // no instalado: stub
  }
  const dir = join(repoRoot, "node_modules", "@earendil-works", "pi-tui");
  try {
    await access(join(dir, "package.json"));
    return;
  } catch {
    // crear
  }
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0", type: "module", main: "index.js" }, null, 2)
  );
  await writeFile(
    join(dir, "index.js"),
    `export const truncateToWidth = (s, w, e = "…") => (s.length > w ? s.slice(0, Math.max(1, w - 1)) + e : s);
export const visibleWidth = (s) => [...String(s)].length;
export const Key = { ctrlAlt: (k) => \`ctrl+alt+\${k}\` };
`
  );
}
