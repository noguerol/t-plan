/**
 * Spec-driven project memory — pure helpers.
 *
 * Nothing here touches the filesystem, the runtime state or pi: given a spec
 * document / long prompt it extracts atomic requirements, measures coverage over
 * the live task list, and decides whether a spec-derived task has been verified.
 * The runtime wires these into the plan file and the injected context.
 */
import type { PlanRequirement, PlanTask, SpecSource } from "./types.ts";

/** How many backlog tasks are promoted into the active lane (see runtime). */
export const SPEC_ACTIVE_WINDOW = 5;
/** Hard cap of requirements extracted per source, so a huge doc cannot explode the plan. */
export const MAX_REQUIREMENTS = 80;
/** Hard cap of requirements kept for the whole project (all sources combined). */
export const MAX_PROJECT_REQUIREMENTS = 200;
/** Newest K sources are authoritative; older ones are retracted automatically. */
export const MAX_SPEC_SOURCES = 8;

/** Deterministic 32-bit-ish djb2 hash, hex. Never empty, stable across sessions. */
export function hashText(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
  }
  const tail = text.length;
  return ((h >>> 0).toString(16) + tail.toString(16)).slice(0, 16);
}

const SPEC_KEYWORDS =
  /\b(?:specs?|specification|requisitos?|requirements?|acceptance\s+criteria|criterios?\s+de\s+aceptaci[oó]n|RF-?\d+|RNF-?\d+|MUST|SHALL|DEBE(?:R[ÁA])?|entregables?|deliverables?|user\s+stor(?:y|ies)|historias?\s+de\s+usuario)\b/i;

/** Stable requirement identifiers a real spec uses: RF-3, RNF-12, REQ-1, P0-REQ-2… */
const SPEC_ID_RE = /\b(?:P[01]-REQ|RNF|RF|REQ)-?\d+\b/i;
/** Headings that declare a normative section (requirements, scope, deliverables…). */
const NORMATIVE_ANCHOR_WORDS = [
  "requirements", "requirement", "requisitos", "requisito",
  "acceptance criteria", "criterios de aceptacion", "criterios de aceptación",
  "scope", "alcance", "deliverables", "entregables", "objetivos", "goals",
  "functional requirements", "requisitos funcionales",
  "non functional requirements", "requisitos no funcionales",
];
/** Metadata labels that never describe an obligation (`key: value` notes). */
const META_KEY_RE =
  /^\**\s*(?:id|uuid|guid|hash|sha\d*|ref|source|sourceid|status|estado|date|fecha|time|hora|version|ver|path|ruta|file|fichero|filename|why|por\s*qu[eé]|purpose|prop[oó]sito|method|m[eé]todo|approach|enfoque|summary|resumen|context|contexto|notes?|notas?|next|siguiente|blockers?|bloqueos?|goal|objetivo|what|how|fix(?:es|ed)?|solution|soluci[oó]n|change|cambio|result|resultado|impact|impacto|problem|problema|issue|risk|riesgo)\s*[:：]/i;
/** A bullet that is nothing but a file path (POSIX or Windows separators). */
const BARE_PATH_RE =
  /^~?[\w./@\\-]+\.(?:md|markdown|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|ini|cfg|lock|env|css|scss|less|html|py|rb|go|rs|java|kt|swift|php|sql|sh|bash|zsh|svg|png|jpe?g|gif)$/i;
/** A bullet that is nothing but an identifier token (UUID / truncated UUID / hash). */
const BARE_ID_RE = /^[0-9a-f]{4,}(?:-[0-9a-f]{2,}){1,4}$/i;
/** Bullets that START with an obligation verb are requirements, not notes. */
const STARTS_OBLIGATION_RE =
  /^(?:implement|create|add|build|write|refactor|migrate|integrate|validate|support|expose|emit|persist|return|refund|lock|alert|authenticate|ensure|provide|allow|enable|handle|display|store|notify|use|include|define|configure|document|test|check|remove|update|fix|deploy|implementa|crea|a[ñn]ade|agrega|valida|permite|soporta|expone|emite|persiste|devuelve|notifica|asegura|proporciona|incluye|define|configura|documenta|prueba|verifica|elimina|actualiza|corrige|despliega)\b/i;
/** A documentation line about the document itself, never a product requirement. */
const DOC_META_RE = /\bthis (?:file|doc(?:ument)?|plan|readme|guide|report|memory|section|repo)\b/i;
const NEVER_COMMIT_RE = /\bnever\s+(?:be\s+)?(?:committed|commit|shared|published)\b/i;
/** Metrics and pass ratios are status lines, not requirements. */
const METRIC_RE = /^\d+\s*(?:tests?|specs?|checks?|files?|lines?|tasks?|commits?|assertions?|suites?)\b/i;
const RATIO_RE = /^\d+\s*\/\s*\d+\b/;

/** Normalizes a heading so emoji/punctuation do not hide its meaning. */
function normalizeAnchor(anchor: string | undefined): string {
  if (!anchor) return "";
  return anchor
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function anchorAllowsRequirements(anchor: string | undefined): boolean {
  const norm = normalizeAnchor(anchor);
  if (!norm) return false;
  return NORMATIVE_ANCHOR_WORDS.some((word) => norm === word || norm.includes(word));
}

/**
 * Non-normative noise that must never become a requirement: bare paths, bare
 * UUIDs, metric/summary lines and `key: value` metadata notes.
 */
export function isNonNormativeLine(text: string): boolean {
  const t = stripMarkdown(text).trim();
  if (!t) return true;
  if (BARE_PATH_RE.test(t)) return true;
  if (BARE_ID_RE.test(t)) return true;
  if (METRIC_RE.test(t) || RATIO_RE.test(t)) return true;
  if (META_KEY_RE.test(t)) return true;
  // "R73" / "R142" residue after the bullet marker
  if (/^[RS]\d+\.?$/.test(t)) return true;
  return false;
}

/**
 * Is this bullet an obligation? Only modal/action verbs, requirement ids or an
 * explicit normative section make a bullet a requirement. Everything else
 * (files touched, changelogs, checklists, status notes) is notes.
 */
export function isDocMetaLine(text: string): boolean {
  const t = stripMarkdown(text).trim();
  return DOC_META_RE.test(t) || NEVER_COMMIT_RE.test(t);
}

export function isNormativeBullet(text: string, anchor?: string): boolean {
  const t = stripMarkdown(text).trim();
  if (!t) return false;
  if (isNonNormativeLine(t)) return false;
  if (isDocMetaLine(t)) return false;
  if (SPEC_ID_RE.test(t)) return true;
  if (MODAL_VERB.test(t)) return true;
  // A generic noun ("api", "module") anywhere is not an obligation; the bullet
  // must start with the verb for the ACTION_VERB vocabulary to count.
  if (STARTS_OBLIGATION_RE.test(t)) return true;
  return anchorAllowsRequirements(anchor);
}

/**
 * Paths that are never a specification, however structured the content is:
 * project memory, plan files, package/licence boilerplate, ADRs, testing notes
 * and anything inside node_modules/.pi. Shared by `isSpecDocument` (referenced
 * files) and the explicit `plan_manager source` action, which is a user opt-in
 * but must still not ingest protected project state.
 */
export function isDeniedSpecPath(ref: string): boolean {
  const path = String(ref ?? "").toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path) return false;
  const base = path.split("/").pop() ?? "";
  if (base === "pi.md" || (base.startsWith("plan_") && base.endsWith(".md"))) return true;
  if (/^(?:readme|license|licence|changelog|changes|contributing|code_of_conduct|security|authors|notice)\b/.test(base)) return true;
  if (path.includes("node_modules/") || path === ".pi" || path.startsWith(".pi/")) return true;
  if (/(?:^|\/)(?:adr|testing)\//.test(path)) return true;
  return false;
}

/**
 * A real specification file: declared by its path (spec/requirements/prd…),
 * by requirement identifiers, or by an explicit requirements heading. Project
 * memory, changelogs, ADRs and testing notes are refused even when structured.
 */
export function isSpecDocument(ref: string, text: string): boolean {
  const path = String(ref ?? "").toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!path) return false;
  const base = path.split("/").pop() ?? "";

  // Path denylist: these are never specifications, however structured they are.
  if (isDeniedSpecPath(path)) return false;

  // Path allowlist: the filename declares itself a spec.
  if (/(?:^|[-_.])(?:spec|specs|specification|especificacion|requirements|requisitos|prd|rfc)(?:[-_.]|$)/.test(base)) return true;
  if (SPEC_ID_RE.test(base)) return true;

  // Content allowlist: identifiers or an explicit requirements heading.
  if (SPEC_ID_RE.test(text ?? "")) return true;
  if (/^#{1,6}\s+.*\b(?:requirements?|requisitos?|acceptance criteria|criterios de aceptaci[oó]n)\b/im.test(text ?? "")) return true;

  return false;
}

/** Short human title for a requirement-backed task (full text stays in `spec`). */
export function requirementTitle(text: string): string {
  const cleaned = stripMarkdown(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const clause = cleaned.split(/(?<=[.;:!?])\s+/)[0] ?? cleaned;
  const short = clause.length <= 80 ? clause : clause.slice(0, 77).trimEnd() + "…";
  return (short || cleaned.slice(0, 80)).replace(/[.;:,]+$/, "").trim();
}

/**
 * Heuristic: is this text a spec / long structured request that deserves an
 * exhaustive, persisted decomposition? Short chatter must return false.
 */
export function looksLikeComplexSpec(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  const normalized = text.replace(/\r\n?/g, "\n");
  if (SPEC_KEYWORDS.test(normalized)) return true;

  const lines = normalized.split("\n").filter((l) => l.trim().length > 0);
  const structural = lines.filter(
    (l) => /^\s*(?:#{1,6}\s+\S|[-*+]\s+\S|\d+[.)]\s+\S)/.test(l)
  ).length;
  // Structure alone is not enough: a notes file is a bullet list too. Require a
  // minimum of bullets that actually read as obligations.
  const normative = lines.filter((l) =>
    isNormativeBullet(l.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, ""))
  ).length;
  if (lines.length >= 8 && structural >= 6 && normative >= 3) return true;

  const headings = (normalized.match(/^#{1,6}\s+\S/gm) ?? []).length;
  if (normalized.length >= 1200 && headings >= 3) return true;

  return false;
}

const MODAL_VERB =
  /\b(?:must|shall|should|will|needs?\s+to|has\s+to|have\s+to|debe(?:r[áa])?|deben|tiene\s+que|tienen\s+que|hay\s+que|soporta(?:r|rá)?|implement(?:a|ar|e|ed)?|crea(?:r|rá)?|a[ñn]ad(?:e|ir|irá)?|agrega(?:r|rá)?|valida(?:r|rá)?|permit(?:e|ir|irá)|muestra|gestiona(?:r|rá)?|soporte|integrat?e?|supports?|supported|allows?|enable?s?|creates?|adds?|provides?|handles?|validat(?:e|es|ed)|display?s?|store?s?|persist?s?|expose?s?|emit(?:s|ted)?|notif(?:y|ies|ied)|return?s?|refund?s?|lock?s?|alert?s?|authenticat(?:e|es|ed))\b/i;

const ACTION_VERB =
  /\b(?:implement|create|add|build|write|refactor|migrate|integrate|validate|support|expose|emit|persist|return|refund|lock|alert|authenticate|endpoint|api|component|module|screen|page|database|auth|test|deploy|configur\w*)\b/i;
/** Strong obligation modals only: prose in an ADR ("we will…") must not qualify. */
const OBLIGATION_VERB =
  /\b(?:must|shall|debe(?:r[áa])?|deben|tiene\s+que|tienen\s+que|hay\s+que|needs?\s+to|has\s+to|have\s+to)\b/i;

function stripMarkdown(text: string): string {
  // Tolerance is the contract: these helpers are called with hostile input by
  // tests/diagnostics, and a non-string must yield "" rather than throw.
  if (typeof text !== "string") return "";
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*>\s?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "these", "those", "of", "to", "into",
  "a", "an", "as", "at", "by", "in", "on", "or", "is", "are", "be", "must", "shall", "should",
  "will", "debe", "deben", "que", "los", "las", "con", "sin", "por", "para", "una", "uno",
  "del", "como", "task", "tasks", "step", "steps", "requirement", "requirements", "tarea",
  "tareas", "paso", "pasos",
]);

/** Dedupe key: case/diacritic-insensitive, punctuation-free, stopwords dropped. */
export function requirementSignature(text: string): string {
  return stripMarkdown(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .split(" ")
    // Keep single-character tokens (digits, letters): dropping them merged
    // distinct requirements such as "Support HTTP/2." and "Support HTTP/3.".
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
    .join(" ");
}

export interface RawRequirement {
  sourceId: string;
  anchor?: string;
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_RE = /^\s{0,3}[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const NUMBERED_RE = /^\s{0,3}\d+[.)]\s+(.+?)\s*$/;

function cleanRequirement(raw: string): string {
  return stripMarkdown(raw)
    .replace(/^[:：\-–—]\s*/, "")
    .replace(/\s*[:：]\s*$/, "")
    .trim();
}

function acceptable(text: string): boolean {
  if (text.length < 12) return false;
  if (/^(?:status|estado|resumen|summary)\b/i.test(text)) return false;
  if (/^[#*\-=_]{3,}$/.test(text)) return false;
  return true;
}

/**
 * Extract atomic requirements from a spec document or structured prompt.
 * Tolerance is the contract: malformed input yields [], never a throw.
 */
export function extractRequirements(text: string, sourceId: string): RawRequirement[] {
  const out: RawRequirement[] = [];
  if (typeof text !== "string" || !text.trim()) return out;

  const seen = new Set<string>();
  const push = (raw: string, anchor: string | undefined): void => {
    const cleaned = cleanRequirement(raw);
    if (!acceptable(cleaned)) return;
    if (isNonNormativeLine(cleaned)) return;
    const sig = requirementSignature(cleaned);
    if (!sig || seen.has(sig)) return;
    seen.add(sig);
    out.push({ sourceId, ...(anchor ? { anchor } : {}), text: cleaned.slice(0, 400) });
  };

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let anchor: string | undefined;
  let sectionHasList = false;
  let sectionParagraph: string[] = [];

  const flushParagraph = (): void => {
    if (sectionHasList) return;
    const block = sectionParagraph.join(" ").trim();
    sectionParagraph = [];
    if (!block) return;
    for (const sentence of block.split(/(?<=[.!?;])\s+/)) {
      const s = sentence.trim();
      if (!s || !acceptable(s)) continue;
      if (isNonNormativeLine(s) || isDocMetaLine(s)) continue;
      // Prose must read as an obligation (strong modal or leading verb). A
      // filename containing "test"/"api", or an ADR's "we will…", is not enough.
      if (OBLIGATION_VERB.test(s) || STARTS_OBLIGATION_RE.test(s)) push(s, anchor);
    }
  };

  for (const line of lines) {
    if (out.length >= MAX_REQUIREMENTS) break;
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    // Blockquotes are quotes/callouts, never obligations (project memory's
    // privacy banner lives here).
    if (trimmed.startsWith(">")) {
      flushParagraph();
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      anchor = level <= 2 ? heading[2].trim() : `${heading[2].trim()}`;
      sectionHasList = false;
      continue;
    }

    const bullet = line.match(BULLET_RE) ?? line.match(NUMBERED_RE);
    if (bullet) {
      // Any list turns off paragraph mining for the section, but only normative
      // bullets become requirements (RC-2: a files-touched list is not a spec).
      sectionHasList = true;
      if (isNormativeBullet(bullet[1], anchor)) push(bullet[1], anchor);
      continue;
    }

    sectionParagraph.push(cleanRequirement(line));
  }
  flushParagraph();

  return out.slice(0, MAX_REQUIREMENTS);
}

/** Default acceptance checks: code work must compile and be tested, not just exist. */
export function defaultChecksFor(text: string): string[] {
  if (ACTION_VERB.test(text) || /\b(?:code|c[oó]digo|endpoint|api|component|module|script|ui|css|database|db|auth)\b/i.test(text)) {
    return ["compiles/typechecks", "tests pass", "behavior matches the spec excerpt"];
  }
  return ["matches the spec excerpt"];
}

export function specTitle(text: string): string | undefined {
  const heading = text.replace(/\r\n?/g, "\n").match(/^#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 80);
  const first = text
    .split(/\r?\n/)
    .map((l) => stripMarkdown(l))
    .find((l) => l.length > 0);
  return first ? first.slice(0, 80) : undefined;
}

export function makeSpecSource(
  id: string,
  kind: "file" | "prompt",
  ref: string,
  text: string,
  requirementCount: number
): SpecSource {
  const title = specTitle(text);
  return {
    id,
    kind,
    ref,
    ...(title ? { title } : {}),
    hash: hashText(text),
    addedAt: Date.now(),
    requirementCount,
  };
}

function nextNumericId(ids: Array<{ id: string }> | undefined, prefix: string): string {
  let max = 0;
  for (const item of ids ?? []) {
    const m = /^([SR])(\d+)$/.exec(item.id);
    if (m && m[1] === prefix) max = Math.max(max, Number.parseInt(m[2], 10));
  }
  return `${prefix}${max + 1}`;
}

export function nextSpecId(specs: SpecSource[] | undefined): string {
  return nextNumericId(specs, "S");
}

export function nextRequirementId(reqs: PlanRequirement[] | undefined): string {
  return nextNumericId(reqs, "R");
}

export interface CoverageReport {
  total: number;
  mapped: number;
  satisfied: number;
  percent: number;
  unmapped: PlanRequirement[];
  unsatisfied: PlanRequirement[];
}

export function computeCoverage(
  requirements: PlanRequirement[] | undefined,
  tasks: PlanTask[]
): CoverageReport {
  const reqs = requirements ?? [];
  const byReq = new Map<string, { mapped: boolean; done: boolean }>();
  for (const r of reqs) byReq.set(r.id, { mapped: false, done: false });

  for (const task of tasks) {
    for (const id of task.reqs ?? []) {
      const slot = byReq.get(id);
      if (!slot) continue;
      slot.mapped = true;
      if (task.status === "done") slot.done = true;
    }
  }

  const unmapped: PlanRequirement[] = [];
  const unsatisfied: PlanRequirement[] = [];
  let mapped = 0;
  let satisfied = 0;
  for (const r of reqs) {
    const slot = byReq.get(r.id)!;
    if (slot.mapped) mapped++;
    else unmapped.push(r);
    if (slot.done) satisfied++;
    else unsatisfied.push(r);
  }

  return {
    total: reqs.length,
    mapped,
    satisfied,
    percent: reqs.length ? Math.round((satisfied / reqs.length) * 100) : 100,
    unmapped,
    unsatisfied,
  };
}

function gapLabel(r: PlanRequirement): string {
  return `${r.id}${r.anchor ? ` ${r.anchor}` : ""}`;
}

/**
 * Compact context block. Returns "" when there are no requirements, so plans
 * without specs keep their injected context unchanged.
 */
export function formatCoverageContext(
  requirements: PlanRequirement[] | undefined,
  tasks: PlanTask[],
  maxGaps = 12
): string {
  if (!requirements?.length) return "";
  const cov = computeCoverage(requirements, tasks);
  const lines = [
    "[SPEC]",
    `coverage: ${cov.satisfied}/${cov.total} satisfied · ${cov.mapped}/${cov.total} mapped (${cov.percent}%)`,
  ];
  if (cov.unsatisfied.length > 0) {
    const labels = cov.unsatisfied.slice(0, maxGaps).map(gapLabel).join("; ");
    const more = cov.unsatisfied.length > maxGaps ? ` … +${cov.unsatisfied.length - maxGaps}` : "";
    lines.push(`gaps: ${labels}${more}`);
  }
  return lines.join("\n");
}

/** A task is spec-derived when it carries the spec excerpt or acceptance checks. */
export function taskVerificationRequired(task: PlanTask): boolean {
  return Boolean(task.spec) || (task.check?.length ?? 0) > 0;
}

/**
 * Verified when the model recorded it (plan_manager verify) or the current run
 * actually executed a build/test command. Non-spec tasks are trivially verified.
 */
export function taskVerified(task: PlanTask, testRuns: number): boolean {
  if (!taskVerificationRequired(task)) return true;
  if (typeof task.verifiedAt === "number" && task.verifiedAt > 0) return true;
  return testRuns > 0;
}

/** Parse the `reqs` tool parameter ("R2, R5" / "R2 R5" / "R2;R5") into stable ids. */
export function parseReqs(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids = raw
    .split(/[,;\s|]+/)
    .map((s) => s.trim().replace(/^#/, "").toUpperCase())
    .filter((s) => /^R\d+$/.test(s));
  return [...new Set(ids)];
}

/** Parse the `check` tool parameter ("compiles | tests pass") into steps. */
export function parseChecks(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s*\|\s*|\s*;\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}
