/**
 * Utility functions for the Plan extension
 */

import type { PlanTask, PlanState, TaskStatus } from "./types.ts";
import { formatElapsed, tierBadge, tierColor } from "./tiers.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Generate a unique ID for tasks
 */
export function generateId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Session-scoped plan files ──────────────────────────────────────────────
//
// Every pi session owns its plan file: <prefix>_<title-slug>_<session-id>.md
// (e.g. plan_myapp_01a048c3.md). Multiple pi instances working in the same
// directory therefore never collide, and a plan file can always be traced
// back to the session that created it.

/** Normalize a title into a filename-safe slug ("Mi Proyecto!" → "mi-proyecto"). */
export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Title → project name, dropping the localized "Plan" wrapper
 *  ("myapp Plan" → "myapp", "Plan de myapp" → "myapp"). */
export function titleToProjectName(title: string): string {
  const stripped = title
    .replace(/^plan\s+de\s+/i, "")
    .replace(/^plan\s+/i, "")
    .replace(/\s+plan$/i, "")
    .trim();
  return stripped || title;
}

/** Build the session-scoped plan file name: <prefix>_<title-slug>_<session-id>.md */
export function planFileNameFor(prefix: string, title: string, sessionId: string | undefined): string {
  const slug = slugify(titleToProjectName(title)) || "untitled";
  const id = sessionId ? sessionId.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8) : "noid";
  return `${prefix}_${slug}_${id}.md`;
}

export interface ParsedPlanFileName {
  titleSlug: string;
  /** Short (8-char) session id baked into the name, when present. */
  sessionId: string | undefined;
}

const SHORT_ID_RE = "[0-9a-zA-Z]{6,12}|noid";

/** Parse a session-scoped plan file name produced by planFileNameFor. */
export function parsePlanFileName(name: string, prefix: string): ParsedPlanFileName | null {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}_(?<slug>.+)_(?<id>${SHORT_ID_RE})\\.md$`, "i");
  const m = name.match(re);
  if (!m || !m.groups) return null;
  return {
    titleSlug: m.groups.slug,
    sessionId: m.groups.id === "noid" ? undefined : m.groups.id,
  };
}

/** De-slug a title slug for display when the file has no readable title ("mi-app" → "Mi App"). */
export function deslugTitle(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// ─── Language detection (for localized plan titles) ────────────────────
// The extension UI is English, but plan titles and tasks follow the language
// the user and the model are using.

const ES_ACCENTS = /[áéíóúñü¿¡]/gi;
const ES_WORDS = /\b(?:el|la|los|las|un|una|unos|unas|del|al|por|para|con|sin|que|como|pero|más|mas|ya|es|son|ser|este|esta|esto|tarea|tareas|paso|pasos|implementar|implementación|crear|creación|añadir|añadido|configurar|configuración|actualizar|revisar|arreglar|corregir|diseñar|arquitectura|autenticación|documento|documentación)\b/gi;
const EN_WORDS = /\b(?:the|and|for|with|from|that|this|these|those|of|to|into|task|tasks|step|steps|plan|implement|implementation|create|adding|add|update|review|fix|fixing|design|architecture|authentication|document|documentation|endpoint)\b/gi;

/** Best-effort language detection of plan/task text ("es" | "en"). */
export function detectLanguage(text: string): "en" | "es" {
  if (!text) return "en";
  const accents = (text.match(ES_ACCENTS)?.length ?? 0) * 2;
  const esWords = text.match(ES_WORDS)?.length ?? 0;
  const enWords = text.match(EN_WORDS)?.length ?? 0;
  return accents + esWords > enWords ? "es" : "en";
}

/** Localized default plan title for a project (directory) name. */
export function planTitle(projectName: string, lang: "en" | "es"): string {
  const name = projectName.trim() || "project";
  return lang === "es" ? `Plan de ${name}` : `${name} Plan`;
}

/**
 * Parse plan tasks from model output text
 * Supports various formats:
 * - Numbered lists: "1. Task description"
 * - Checkbox style: "- [ ] Task" or "- [x] Task"
 * - Dash lists: "- Task description"
 * - Headers with steps: "## Step 1: Description"
 */
export function extractPlanTasks(text: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const lines = text.split("\n");
  
  // Patterns to match plan items
  const patterns = [
    // Numbered: "1. Task" or "1) Task"
    /^\s*(\d+)[.)]\s+(.+)$/,
    // Checkbox: "- [ ] Task" or "- [x] Task" or "- [X] Task"
    /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/,
    // Step header: "## Step 1: Description" or "### Step 1 - Description"
    /^#{1,4}\s+Step\s+(\d+)[:\s-]+(.+)$/i,
    // Plan header followed by items
    /^\s*[-*]\s+(.+)$/,
  ];

  let inPlanSection = false;
  let planSectionFound = false;
  let currentStatus: TaskStatus = "pending";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingStatus = statusFromHeading(line);
    
    // Detect plan/status section headers. Generated plan.md groups tasks by
    // status, so keep that status while parsing the following list items.
    if (headingStatus) {
      inPlanSection = true;
      planSectionFound = true;
      currentStatus = headingStatus;
      continue;
    }

    if (isPlanSectionHeading(line)) {
      inPlanSection = true;
      planSectionFound = true;
      currentStatus = "pending";
      continue;
    }

    // Stop at the next unrelated major section.
    if (inPlanSection && /^#{1,2}\s+(?!Step)/i.test(line) && planSectionFound) {
      if (!/^#{1,4}\s+Step\s+\d+/i.test(line)) {
        inPlanSection = false;
        currentStatus = "pending";
      }
    }

    // Try numbered pattern first (most common)
    const numberedMatch = line.match(patterns[0]);
    if (numberedMatch && (inPlanSection || !planSectionFound)) {
      const step = parseInt(numberedMatch[1]);
      const text = cleanTaskText(numberedMatch[2]);
      if (text.length > 3 && !isSummaryLine(text)) {
        tasks.push({
          id: generateId(),
          text,
          status: currentStatus,
          order: step,
        });
      }
      continue;
    }

    // Try checkbox pattern
    const checkboxMatch = line.match(patterns[1]);
    if (checkboxMatch) {
      const isDone = checkboxMatch[1].toLowerCase() === "x";
      const text = cleanTaskText(checkboxMatch[2]);
      if (text.length > 3 && !isSummaryLine(text)) {
        tasks.push({
          id: generateId(),
          text,
          status: isDone ? "done" : currentStatus,
          order: tasks.length + 1,
        });
      }
      continue;
    }

    // Try step header pattern
    const stepMatch = line.match(patterns[2]);
    if (stepMatch) {
      const step = parseInt(stepMatch[1]);
      const text = cleanTaskText(stepMatch[2]);
      if (text.length > 3 && !isSummaryLine(text)) {
        tasks.push({
          id: generateId(),
          text,
          status: currentStatus,
          order: step,
        });
      }
      continue;
    }

    // Try dash list in plan section
    if (inPlanSection) {
      const dashMatch = line.match(patterns[3]);
      if (dashMatch) {
        const text = cleanTaskText(dashMatch[1]);
        if (text.length > 3 && !text.startsWith("#") && !isSummaryLine(text)) {
          tasks.push({
            id: generateId(),
            text,
            status: currentStatus,
            order: tasks.length + 1,
          });
        }
      }
    }
  }

  return tasks;
}

/**
 * Clean task text by removing markdown formatting
 */
function cleanTaskText(text: string): string {
  return text
    .replace(/\((?:→|->)\s*t[0-3]\)/gi, "")   // tier marker written by generatePlanMarkdown
    .replace(/\(took\s+[\d:]+\)/gi, "")        // completion timer written by generatePlanMarkdown
    .replace(/⏱\s*[\d:]+/g, "")                 // running timer written by generatePlanMarkdown
    .replace(/\[t[0-3]\]/gi, "")                // tier badges
    .replace(/\*\*([^*]+)\*\*/g, "$1")  // Remove bold
    .replace(/\*([^*]+)\*/g, "$1")      // Remove italic
    .replace(/`([^`]+)`/g, "$1")        // Remove code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove links
    .replace(/\s+/g, " ")
    .trim();
}

function headingText(line: string): string | undefined {
  const match = line.match(/^#{1,6}\s+(.+)$/);
  if (!match) return undefined;
  return match[1]
    .replace(/^[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]+/, "")
    .trim();
}

function isPlanSectionHeading(line: string): boolean {
  const heading = headingText(line);
  if (!heading) return false;
  return /^(?:Project\s+Plan|Plan|Implementation\s+Plan|Task\s+List|TODO|Steps|Action\s+Plan|Updated\s+Plan|Revised\s+Plan|Current\s+Plan|Remaining\s+Tasks|Pending\s+Tasks|Next\s+Steps|Backlog|Roadmap|Status|Estado|Plan\s+actualizado|Plan\s+revisado|Plan\s+actual|Tareas|Tareas\s+pendientes|Pr[oó]ximos\s+pasos)/i.test(heading);
}

function statusFromHeading(line: string): TaskStatus | undefined {
  const heading = headingText(line);
  if (!heading) return undefined;

  // "## Status: 3/7 completed" is a summary heading, not a completed-task section.
  if (/^(?:Status|Estado)\b/i.test(heading)) return undefined;

  if (/\b(?:done|completed|complete|finished|hech[oa]s?|completad[oa]s?|terminad[oa]s?)\b/i.test(heading)) {
    return "done";
  }
  if (/\b(?:in[-\s]?progress|doing|active|started|en\s+progreso|en\s+curso|en\s+marcha)\b/i.test(heading)) {
    return "in_progress";
  }
  if (/\b(?:blocked|stuck|deferred|waiting|bloquead[oa]s?|atascad[oa]s?|aplazad[oa]s?|esperando)\b/i.test(heading)) {
    return "blocked";
  }
  if (/\b(?:pending|remaining|todo|next|upcoming|pendientes?|restantes?|pr[oó]xim[oa]s?)\b/i.test(heading)) {
    return "pending";
  }
  return undefined;
}

/**
 * Detect if text contains a plan structure
 */
export function containsPlan(text: string): boolean {
  // Check for plan section headers (including generated plan.md status groups)
  if (text.split("\n").some((line) => isPlanSectionHeading(line) || statusFromHeading(line))) {
    return true;
  }

  // Check for multiple numbered items (3+ suggests a plan)
  const numberedItems = text.match(/^\s*\d+[.)]\s+.+$/gm);
  if (numberedItems && numberedItems.length >= 3) {
    return true;
  }

  // Check for multiple checkbox items
  const checkboxItems = text.match(/^\s*[-*]\s+\[[ xX]\]\s+.+$/gm);
  if (checkboxItems && checkboxItems.length >= 3) {
    return true;
  }

  return false;
}

/**
 * Generate plan.md content from state
 */
export interface PlanMarkdownOptions {
  trimegisto?: boolean;  // include tier assignments
  showTimers?: boolean;  // include elapsed-time counters
}

export function generatePlanMarkdown(state: PlanState, options: PlanMarkdownOptions = {}): string {
  const lines: string[] = [];
  
  lines.push(`# ${state.title}`);
  lines.push("");
  
  if (state.description) {
    lines.push(state.description);
    lines.push("");
  }

  // Status summary
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.status === "done").length;
  const inProgress = state.tasks.filter(t => t.status === "in_progress").length;
  const pending = state.tasks.filter(t => t.status === "pending").length;
  const blocked = state.tasks.filter(t => t.status === "blocked").length;

  lines.push(`## Status: ${done}/${total} completed`);
  lines.push("");
  
  if (inProgress > 0) lines.push(`- 🔄 In progress: ${inProgress}`);
  if (pending > 0) lines.push(`- ⏳ Pending: ${pending}`);
  if (blocked > 0) lines.push(`- 🚫 Blocked: ${blocked}`);
  if (done > 0) lines.push(`- ✅ Completed: ${done}`);
  lines.push("");

  // Tasks grouped by status
  const inProgressTasks = state.tasks.filter(t => t.status === "in_progress");
  const pendingTasks = state.tasks.filter(t => t.status === "pending");
  const blockedTasks = state.tasks.filter(t => t.status === "blocked");
  const doneTasks = state.tasks.filter(t => t.status === "done");

  const showTier = options.trimegisto === true;
  const showTimers = options.showTimers !== false;
  const now = Date.now();

  const tierSuffix = (task: PlanTask): string => {
    if (!showTier || !task.tier) return "";
    return ` (→ ${task.tier})`;
  };

  if (inProgressTasks.length > 0) {
    lines.push("## 🔄 In Progress");
    lines.push("");
    for (const task of inProgressTasks.sort((a, b) => a.order - b.order)) {
      const agent = task.agentName ? ` (agent: ${task.agentName})` : "";
      const timer = showTimers && task.startedAt ? ` ⏱ ${formatElapsed(now - task.startedAt)}` : "";
      lines.push(`- [ ] ${task.text}${timer}${tierSuffix(task)}${agent}`);
    }
    lines.push("");
  }

  if (pendingTasks.length > 0) {
    lines.push("## ⏳ Pending");
    lines.push("");
    for (const task of pendingTasks.sort((a, b) => a.order - b.order)) {
      lines.push(`- [ ] ${task.text}${tierSuffix(task)}`);
    }
    lines.push("");
  }

  if (blockedTasks.length > 0) {
    lines.push("## 🚫 Blocked");
    lines.push("");
    for (const task of blockedTasks.sort((a, b) => a.order - b.order)) {
      const note = task.notes ? ` — ${task.notes}` : "";
      lines.push(`- [ ] ${task.text}${tierSuffix(task)}${note}`);
    }
    lines.push("");
  }

  if (doneTasks.length > 0) {
    lines.push("## ✅ Completed");
    lines.push("");
    for (const task of doneTasks.sort((a, b) => a.order - b.order)) {
      const took = showTimers && task.startedAt && task.completedAt
        ? ` (took ${formatElapsed(task.completedAt - task.startedAt)})`
        : "";
      lines.push(`- [x] ${task.text}${took}${tierSuffix(task)}`);
    }
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push(`*Last updated: ${new Date(state.updatedAt).toLocaleString()}*`);

  return lines.join("\n");
}

/**
 * Format task status icon
 */
export function getStatusIcon(status: TaskStatus): string {
  switch (status) {
    case "done": return "✅";
    case "in_progress": return "🔄";
    case "pending": return "⏳";
    case "blocked": return "🚫";
  }
}

export interface PlanWidgetTheme {
  bold?: (text: string) => string;
  fg?: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  strikethrough?: (text: string) => string;
}

export interface FormatTaskForWidgetOptions {
  lineBudget?: number;
  highlight?: boolean;
  spinnerFrame?: number;
  spinnerFrames?: string[];
  showTier?: boolean;   // show trimegisto tier badge
  showTimers?: boolean; // show elapsed timer on in-progress tasks
  now?: number;         // current timestamp (injectable for tests)
}

/**
 * Format task for display in widget as a single compact line.
 */
export function formatTaskForWidget(ctx: { ui: { theme: PlanWidgetTheme } }, task: PlanTask, options: FormatTaskForWidgetOptions & { compact?: boolean } = {}): string {
  const theme = ctx.ui.theme;
  const spinnerFrames = options.spinnerFrames ?? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = spinnerFrames[options.spinnerFrame ?? 0] ?? spinnerFrames[0];

  const prefix = task.status === "in_progress" ? `${spinner}` : "";
  const marker = task.status === "in_progress" ? "" : getStatusIcon(task.status) + " ";
  const rawAgent = task.agentName ? ` [${task.agentName}]` : "";
  const agent = task.agentName ? theme.fg?.("muted", rawAgent) ?? rawAgent : "";
  const spacer = task.status === "in_progress" ? " " : "";

  const showTier = options.showTier === true;
  const rawTier = showTier && task.tier ? ` ${tierBadge(task.tier)}` : "";
  const tier = rawTier ? theme.fg?.(tierColor(task.tier), rawTier) ?? rawTier : "";

  const showTimers = options.showTimers !== false;
  const rawTimer =
    showTimers && task.status === "in_progress" && task.startedAt
      ? ` ⏱ ${formatElapsed((options.now ?? Date.now()) - task.startedAt)}`
      : "";
  const timer = rawTimer ? theme.fg?.("muted", rawTimer) ?? rawTimer : "";

  const head = `${prefix}${spacer}${marker}`;
  const headWidth = visibleWidth(head);

  const styleText = (value: string, highlight = options.highlight) => {
    if (task.status === "done") {
      const muted = theme.fg?.("muted", value) ?? value;
      const strikethrough = theme.strikethrough?.(muted) ?? muted;
      return highlight ? theme.bg?.("selectedBg", strikethrough) ?? theme.fg?.("success", strikethrough) ?? strikethrough : strikethrough;
    }
    if (task.status === "in_progress") {
      const accent = theme.fg?.("accent", value) ?? value;
      return highlight ? theme.bg?.("selectedBg", accent) ?? accent : accent;
    }
    if (task.status === "blocked") {
      const error = theme.fg?.("error", value) ?? value;
      return highlight ? theme.bg?.("selectedBg", error) ?? error : error;
    }
    return value;
  };

  let text = styleText(task.text);

  const line = `${head}${text}${tier}${timer}${agent}`;
  const lineBudget = options.lineBudget ?? 70;
  if (options.compact === false || visibleWidth(line) <= lineBudget) {
    return line;
  }

  // Keep the marker/icon, tier badge, timer and agent label stable, then
  // truncate only the task text with a single ellipsis.
  const rawText = task.text.replace(/\s+/g, " ").trim();
  const suffixWidth = visibleWidth(tier) + visibleWidth(timer) + visibleWidth(agent);
  const textBudget = Math.max(8, lineBudget - headWidth - suffixWidth - 1);
  const truncatedText = truncateToWidth(rawText, textBudget, "…");
  const styled = styleText(truncatedText);
  return `${head}${styled}${tier}${timer}${agent}`;
}

/**
 * Parse DONE markers from agent output
 * Supports: [DONE:task_id], [DONE:1], ✅ task text
 */
export function parseDoneMarkers(text: string, tasks: PlanTask[]): string[] {
  const completedIds: string[] = [];
  
  // Match [DONE:id] or [DONE:1]
  const doneIdMatches = text.matchAll(/\[DONE:([^\]]+)\]/gi);
  for (const match of doneIdMatches) {
    const identifier = match[1];
    // Try as task ID first
    const taskById = tasks.find(t => t.id === identifier);
    if (taskById) {
      completedIds.push(taskById.id);
      continue;
    }
    // Try as step number
    const stepNum = parseInt(identifier);
    if (!isNaN(stepNum)) {
      const taskByOrder = tasks.find(t => t.order === stepNum);
      if (taskByOrder) {
        completedIds.push(taskByOrder.id);
      }
    }
  }

  return completedIds;
}

/**
 * Skip "summary" lines that appear inside generated plan.md files
 * (e.g. "- ✅ Completed: 3", "- 🔄 In progress: 2"). These are status
 * counters, not tasks, and pollute the task list when the file is loaded.
 */
function isSummaryLine(text: string): boolean {
  if (/^(?:🔄|⏳|🚫|✅|📋|📈|⚡)\s*(?:In progress|Pending|Blocked|Completed|Progress|Status)/i.test(text)) {
    return true;
  }
  if (/^\d+\/\d+\s+completed/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * Detect agent spawning patterns in text
 */
export function detectAgentTasks(text: string): Array<{ agentId: string; agentName: string; taskDescription: string }> {
  const agents: Array<{ agentId: string; agentName: string; taskDescription: string }> = [];
  
  // Match patterns like "Launching agent for X" or "Spawning agent: X"
  const spawnPatterns = [
    /(?:launching|spawning|starting)\s+agent\s+(?:for|to|:)\s*(.+)/gi,
    /Agent\s+\(([^)]+)\)\s+(?:started|launched|working on)\s*:?\s*(.+)/gi,
    /🔄\s*Agent\s+(\S+)\s*[:-]\s*(.+)/gi,
  ];

  for (const pattern of spawnPatterns) {
    for (const match of text.matchAll(pattern)) {
      agents.push({
        agentId: `agent_${agents.length}`,
        agentName: match[1] || `Agent ${agents.length + 1}`,
        taskDescription: match[2] || match[1] || "Unknown task",
      });
    }
  }

  return agents;
}

// ─── Auto-transition detection ─────────────────────────────────────────
//
// The model rarely emits explicit [DONE:n] markers, so we also detect task
// progress from natural language and tool activity:
//   - Lines like "- [x] …", "✅ …", "✔️ …"  → task completed
//   - Segments with completion verbs ("implemented", "done", "finished"…)
//     that mention a task (fuzzy text match or "task N" references)
//   - Segments with starting language ("starting", "working on"…)
//   - Tool calls whose names/arguments contain the task's distinctive words
//     → task marked in_progress

const COMPLETION_PATTERN = /\b(?:done|complete|completed|finished|implemented|added|created|fixed|resolved|closed|landed|ready|accomplished|wrapped|pass(?:es|ed|ing)?|terminad[oa]|completad[oa]|hech[oa]|implementad[oa]|agregad[oa]|cread[oa]|arreglad[oa]|resuelt[oa]|a\u00f1adid[oa]|incluid[oa]|conseguid[oa]|listo)\b/i;

const START_PATTERN = /\b(?:start(?:ed|ing)?|working\s+on|work\s+on|in\s+progress|begin(?:ning)?|began|on\s+it|empezad[oa]|trabajando\s+en|en\s+progreso|comenzand[oa])\b/i;

const TASK_NUMBER_REF = /\b(?:task|step|item|point|tarea|paso)\s*#?\s*(\d+)\b/gi;

const DONE_LINE_PREFIX = /^\s*(?:[-*]\s+\[[xX]\]\s*|✅\s*|✔️\s*|☑️\s*|✓\s*)(.+)$/;

const STOPWORDS = new Set([
  // English
  "the", "and", "but", "for", "with", "from", "that", "this", "these", "those",
  "have", "has", "had", "was", "were", "been", "being", "not", "you", "your",
  "are", "can", "will", "just", "also", "all", "any", "some", "into", "over",
  "after", "before", "between", "about", "again", "what", "when", "where", "which",
  "who", "whom", "there", "here", "why", "how", "then", "than", "too", "very",
  "should", "could", "would", "must", "shall", "may", "might", "each", "every",
  "other", "others", "another", "more", "most", "such", "only", "own", "same",
  "both", "does", "did", "doing", "one", "two", "three", "first", "second",
  "next", "last", "let", "lets", "way", "make", "made", "get", "got", "use",
  "used", "need", "wants", "want", "like", "look", "see", "going", "go", "went",
  "know", "think", "much", "many", "still", "well", "even", "back", "here",
  "then", "them", "they", "their", "there", "its", "it's",
  // Spanish
  "que", "para", "por", "con", "sin", "los", "las", "una", "unas", "unos",
  "del", "esta", "este", "esto", "ese", "esa", "eso", "pero", "como", "cuando",
  "donde", "muy", "bien", "todo", "toda", "cada", "entre", "hacia", "desde",
  "hasta", "durante", "tambien", "aunque", "porque", "pues", "ser", "estar",
  "haber", "tener", "hacer", "otro", "otra", "otros", "otras", "mas", "ya",
  "les", "sus", "mis", "tus", "nos", "vamos", "voy", "ver", "decir", "quiero",
  "puedo", "podemos", "vamos", "estoy", "esta", "estan", "tenemos", "hace",
]);

/** Light stemming: strip common English/Spanish suffixes. */
function stem(w: string): string {
  if (w.length <= 4) return w;
  let s = w
    .replace(/(ingly|edly)$/, "")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/(ad[oa]s?|iend[oa]s?|and[oa]s?)$/, "")
    .replace(/(ar|er|ir)$/, "");
  return s.length < 3 ? w : s;
}

/**
 * Common ES↔EN vocabulary so bilingual responses still match English tasks.
 * Keys are the stemmed token; values the canonical English stem.
 */
const SYNONYMS: Record<string, string> = {
  purga: "purge", purgar: "purge", purgado: "purge",
  a\u00f1ad: "add", a\u00f1adir: "add", a\u00f1adido: "add", a\u00f1adida: "add",
  agregar: "add", agregado: "add", agregada: "add",
  implementar: "implement", implementado: "implement", implementada: "implement",
  terminar: "done", terminado: "done", terminada: "done",
  completar: "complete", completado: "complete", completada: "complete",
  crear: "create", creado: "create", creada: "create",
  arreglar: "fix", arreglado: "fix", arreglada: "fix",
  resolver: "resolve", resuelto: "resolve", resuelta: "resolve",
  autenticaci\u00f3n: "auth", autenticacion: "auth", autenticar: "auth",
  prueba: "test", pruebas: "test", probar: "test",
  esquema: "schema",
  opci\u00f3n: "option", opcion: "option",
  tarea: "task", tareas: "task", paso: "step", pasos: "step",
  escribir: "write", escribiendo: "write",
  configurar: "config", configuraci\u00f3n: "config", configuracion: "config",
  enviar: "send", recibir: "receive", cargar: "load", guardar: "save",
  eliminar: "remove", borrar: "remove", borrado: "remove",
  buscar: "search", b\u00fasqueda: "search",
  corregir: "fix", corregido: "fix",
  actualizar: "update", actualizado: "update",
};

function normalizeToken(w: string): string {
  return SYNONYMS[w] ?? w;
}

/** Tokenize + stem + remove stopwords, keeping tokens with 3+ chars. */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const w of text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/gi, " ")
    .split(/\s+/)) {
    if (w.length < 3) continue;
    const s = stem(w);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    tokens.add(normalizeToken(s));
  }
  return tokens;
}

/** Exact match after stemming, or substring containment for longer words. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length > a.length && b.includes(a)) return true;
  if (b.length >= 4 && a.length > b.length && a.includes(b)) return true;
  return false;
}

/**
 * Score how well a candidate text (statement/segment/corpus) matches a task.
 * Weighted recall+precision of the task's distinctive tokens.
 */
export function taskTextScore(taskText: string, candidate: string): number {
  const taskTokens = tokenize(taskText);
  const candidateTokens = tokenize(candidate);
  if (taskTokens.size === 0 || candidateTokens.size === 0) return 0;

  let shared = 0;
  for (const token of taskTokens) {
    let found = false;
    for (const cToken of candidateTokens) {
      if (tokensMatch(token, cToken)) {
        found = true;
        break;
      }
    }
    if (found) shared++;
  }

  const recall = shared / taskTokens.size;
  const precision = shared / candidateTokens.size;
  return recall * 0.7 + precision * 0.3;
}

function normalizedTaskSignature(text: string): string {
  return [...tokenize(cleanTaskText(text).replace(/\s+\(agent:\s*[^)]+\)$/i, ""))]
    .sort()
    .join(" ");
}

function sameTaskText(a: string, b: string): boolean {
  const sigA = normalizedTaskSignature(a);
  const sigB = normalizedTaskSignature(b);
  return sigA.length > 0 && sigA === sigB;
}

function mergeStatuses(existing: TaskStatus, incoming: TaskStatus): TaskStatus {
  if (incoming === "done") return "done";
  if (existing === "done") return "done";
  if (incoming === "blocked") return "blocked";
  if (incoming === "in_progress") return "in_progress";
  if (existing === "in_progress" && incoming === "pending") return "in_progress";
  return incoming;
}

export interface PlanReconcileResult {
  tasks: PlanTask[];
  changed: boolean;
  added: number;
  updated: number;
  removed: number;
  statusChanged: number;
  reordered: number;
}

export function hasPlanRefreshCue(text: string): boolean {
  return /\b(?:updated|revised|current|new|remaining|pending|next\s+steps|todo|backlog|roadmap|replace|replan(?:ned)?|discard(?:ed|ing)?|drop(?:ped|ping)?|remove(?:d|ing)?|delete(?:d|ing)?|eliminate(?:d|ing)?|actualizad[oa]s?|actual|revisad[oa]s?|restantes?|pendientes?|pr[oó]ximos\s+pasos|descartad[oa]s?|eliminad[oa]s?|quitad[oa]s?|borrad[oa]s?)\b/i.test(text);
}

export function shouldRemoveMissingTasksFromPlan(text: string): boolean {
  return /\b(?:updated|revised|current|remaining|replace|replan(?:ned)?|clean\s+plan|backlog|roadmap|actualizad[oa]s?|actual|revisad[oa]s?|restantes?|pendientes?|descartad[oa]s?|eliminad[oa]s?|quitad[oa]s?|borrad[oa]s?|no\s+longer|out\s+of\s+scope|fuera\s+de\s+alcance|ya\s+no)\b/i.test(text);
}

export function shouldReconcilePlan(text: string, incoming: PlanTask[], current: PlanTask[]): boolean {
  if (incoming.length === 0) return false;
  if (current.length === 0) return containsPlan(text);

  const matchedIncoming = incoming.filter((candidate) =>
    current.some((task) => sameTaskText(task.text, candidate.text) || taskTextScore(task.text, candidate.text) >= 0.65)
  ).length;

  if (hasPlanRefreshCue(text) && incoming.length >= 2) return true;
  if (containsPlan(text) && incoming.length >= 3 && matchedIncoming > 0) return true;

  return false;
}

export function reconcilePlanTasks(
  current: PlanTask[],
  incoming: PlanTask[],
  options: { removeMissing?: boolean } = {}
): PlanReconcileResult {
  const orderedIncoming = [...incoming].sort((a, b) => a.order - b.order);
  const matchedCurrent = new Set<string>();
  const nextTasks: PlanTask[] = [];
  let added = 0;
  let updated = 0;
  let statusChanged = 0;
  let reordered = 0;

  for (const [index, incomingTask] of orderedIncoming.entries()) {
    let match: PlanTask | undefined;
    let bestScore = 0.68;

    for (const task of current) {
      if (matchedCurrent.has(task.id)) continue;
      if (sameTaskText(task.text, incomingTask.text)) {
        match = task;
        bestScore = 1;
        break;
      }
      const score = taskTextScore(task.text, incomingTask.text);
      if (score > bestScore) {
        bestScore = score;
        match = task;
      }
    }

    const nextOrder = index + 1;
    if (match) {
      matchedCurrent.add(match.id);
      const mergedStatus = mergeStatuses(match.status, incomingTask.status);
      const textChanged = cleanTaskText(match.text) !== cleanTaskText(incomingTask.text) && bestScore < 0.98;
      const task: PlanTask = {
        ...match,
        text: textChanged ? incomingTask.text : match.text,
        status: mergedStatus,
        order: nextOrder,
      };
      if (textChanged) updated++;
      if (match.status !== mergedStatus) statusChanged++;
      if (match.order !== nextOrder) reordered++;
      nextTasks.push(task);
    } else {
      nextTasks.push({ ...incomingTask, order: nextOrder });
      added++;
    }
  }

  let removed = 0;
  const appendStart = nextTasks.length;
  for (const task of [...current].sort((a, b) => a.order - b.order)) {
    if (matchedCurrent.has(task.id)) continue;

    // A refreshed/remaining plan should drop stale unfinished tasks, while
    // completed history is preserved unless the assistant explicitly removes it.
    if (options.removeMissing && task.status !== "done") {
      removed++;
      continue;
    }

    nextTasks.push({ ...task, order: appendStart + (nextTasks.length - appendStart) + 1 });
  }

  // Ensure final order is contiguous even after removals/appends.
  nextTasks.forEach((task, index) => (task.order = index + 1));

  return {
    tasks: nextTasks,
    changed: added > 0 || updated > 0 || removed > 0 || statusChanged > 0 || reordered > 0,
    added,
    updated,
    removed,
    statusChanged,
    reordered,
  };
}

const TASK_REMOVAL_PATTERN = /\b(?:discard(?:ed|ing)?|drop(?:ped|ping)?|delete(?:d|ing)?|eliminate(?:d|ing)?|remove(?:d|ing)?|descart(?:ad[oa]s?|o|amos|ando)|elimin(?:ad[oa]s?|o|amos|ando)|quit(?:ad[oa]s?|o|amos|ando)|borr(?:ad[oa]s?|o|amos|ando))\b.*\b(?:task|item|step|plan|tarea|paso|punto)\b|\b(?:task|item|step|tarea|paso|punto)\b.*\b(?:discarded|dropped|deleted|eliminated|removed|descartad[oa]s?|eliminad[oa]s?|quitad[oa]s?|borrad[oa]s?)\b|\b(?:no\s+longer\s+needed|not\s+needed|out\s+of\s+scope|ya\s+no\s+hace\s+falta|ya\s+no\s+es\s+necesari[oa]|fuera\s+de\s+alcance)\b/i;

export function detectRemovedTasks(text: string, tasks: PlanTask[]): string[] {
  const removedIds: string[] = [];
  const removable = tasks.filter((t) => t.status !== "done");
  if (removable.length === 0) return removedIds;

  for (const segment of splitSegments(text)) {
    if (!TASK_REMOVAL_PATTERN.test(segment)) continue;

    for (const ref of segment.matchAll(TASK_NUMBER_REF)) {
      const order = parseInt(ref[1], 10);
      const task = removable.find((t) => t.order === order);
      if (task && !removedIds.includes(task.id)) removedIds.push(task.id);
    }

    for (const task of removable) {
      if (removedIds.includes(task.id)) continue;
      if (taskTextScore(task.text, segment) >= 0.5) removedIds.push(task.id);
    }
  }

  return removedIds;
}

function bestMatch(candidate: string, tasks: PlanTask[], minScore: number): PlanTask | undefined {
  let best: PlanTask | undefined;
  let bestScore = minScore;
  for (const task of tasks) {
    const score = taskTextScore(task.text, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }
  return best;
}

function splitSegments(text: string): string[] {
  const segments: string[] = [];
  for (const part of text.split(/\n+|(?<=[.!?])\s+/)) {
    const s = part.trim();
    if (s.length > 0 && s.length <= 300) segments.push(s);
  }
  return segments;
}

export interface AutoTransitions {
  completedIds: string[];
  startedIds: string[];
}

/**
 * Detect task progress from an assistant turn: natural language + tool evidence.
 * Returns task IDs that should be marked done / in_progress. Conservative by
 * design: only strong signals (verb + text match, explicit done lines, or
 * distinctive tool-call evidence) trigger transitions.
 */
export function detectAutoTransitions(text: string, toolCorpus: string, tasks: PlanTask[]): AutoTransitions {
  const completedIds: string[] = [];
  const startedIds: string[] = [];

  const active = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  if (active.length === 0) return { completedIds, startedIds };

  // 1. Explicit done lines: "- [x] …", "✅ …", "✔️ …", "☑️ …", "✓ …"
  for (const line of text.split(/\n+/)) {
    const m = line.match(DONE_LINE_PREFIX);
    if (!m) continue;
    const best = bestMatch(m[1], active, 0.5);
    if (best && !completedIds.includes(best.id)) completedIds.push(best.id);
  }

  const segments = splitSegments(text);

  // 2. Segments with completion language
  for (const segment of segments) {
    if (!COMPLETION_PATTERN.test(segment)) continue;

    // 2a. Numbered references: "task 3 done", "step 2 is complete"
    for (const ref of segment.matchAll(TASK_NUMBER_REF)) {
      const order = parseInt(ref[1], 10);
      const task = active.find((t) => t.order === order);
      if (task && !completedIds.includes(task.id)) completedIds.push(task.id);
    }

    // 2b. Fuzzy text match (all tasks passing the threshold)
    for (const task of active) {
      if (completedIds.includes(task.id)) continue;
      if (taskTextScore(task.text, segment) >= 0.55) completedIds.push(task.id);
    }
  }

  // 3. Starting language → in_progress (best single match per turn)
  for (const segment of segments) {
    if (!START_PATTERN.test(segment)) continue;
    const candidates = active.filter(
      (t) => t.status === "pending" && !completedIds.includes(t.id) && !startedIds.includes(t.id)
    );
    const best = bestMatch(segment, candidates, 0.5);
    if (best) startedIds.push(best.id);
  }

  // 4. Tool-call evidence → the task is being worked on
  const corpusTokens = toolCorpus && toolCorpus.trim() ? tokenize(toolCorpus) : new Set<string>();
  if (corpusTokens.size > 0) {
    const candidates = tasks.filter(
      (t) => t.status === "pending" && !completedIds.includes(t.id) && !startedIds.includes(t.id)
    );
    let best: PlanTask | undefined;
    let bestRecall = 0;
    let bestShared = 1;
    for (const task of candidates) {
      const taskTokens = tokenize(task.text);
      if (taskTokens.size === 0) continue;
      let shared = 0;
      for (const token of taskTokens) {
        let found = false;
        for (const cToken of corpusTokens) {
          if (tokensMatch(token, cToken)) {
            found = true;
            break;
          }
        }
        if (found) shared++;
      }
      const recall = shared / taskTokens.size;
      if (shared >= 2 && recall >= 0.5 && (recall > bestRecall || (recall === bestRecall && shared > bestShared))) {
        bestRecall = recall;
        bestShared = shared;
        best = task;
      }
    }
    if (best && !startedIds.includes(best.id)) startedIds.push(best.id);
  }

  return { completedIds, startedIds };
}

// A "generic" completion signal means the model is telling the user that the
// work it was doing is finished, without necessarily naming a specific task
// (e.g. "all done", "everything is complete", "la tarea está terminada").
// Used to resolve tasks that are still marked in_progress when the model stops.
const GENERIC_COMPLETION_PATTERN = /\b(?:all\s+done|all\s+finished|all\s+complete(?:d)?|everything(?:(?:\s+(?:is|was))|(?:'s))?\s+(?:done|complete(?:d)?|finished|ready)|all\s+tasks?\s+(?:are\s+)?(?:done|complete(?:d)?|finished)|(?:the\s+)?work\s+is\s+(?:done|complete(?:d)?|finished)|that\s+(?:completes|concludes|wraps\s+up)|(?:i(?:'ve|\s+have)?|we(?:'ve|\s+have)?)\s+(?:finished|completed)\s+(?:everything|all(?:(?:\s+(?:tasks?|work)))?|the\s+work|the\s+task)|(?:the\s+)?task\s+is\s+(?:done|complete(?:d)?|finished)|todo\s+(?:está|esta)?\s*(?:listo|completo|terminado|hecho|finalizado)|(?:he|hemos|ya\s+he)\s+terminado\s+(?:todo|todas\s+las\s+tareas|el\s+trabajo|la\s+tarea)|(?:la\s+)?tarea\s+(?:está|esta)\s+(?:completada|terminada|hecha|lista|finalizada)|todas\s+las\s+tareas\s+(?:están\s+)?(?:completadas|terminadas|hechas|listas)|ya\s+está\s+todo|todo\s+(?:completado|finalizado)|eso\s+es\s+todo)\b/i;

// A whole-work conclusion means the model signals that the ENTIRE plan is done
// ("all done", "everything is complete", "todo listo"). Unlike a generic
// completion, this resolves EVERY remaining task: active → done, and
// pending/blocked → dropped from the list (the model concluded without doing
// them).
const WORK_CONCLUSION_PATTERN = /\b(?:all\s+done|all\s+finished|all\s+complete(?:d)?|everything(?:(?:\s+(?:is|was))|(?:'s))?\s+(?:done|complete(?:d)?|finished|ready)|all\s+tasks?\s+(?:are\s+)?(?:done|complete(?:d)?|finished)|(?:the\s+)?(?:work|plan|implementation)\s+is\s+(?:done|complete(?:d)?|finished)|that\s+(?:completes|concludes|wraps\s+up)(?:\s+(?:the\s+)?(?:work|plan|everything|it))?|(?:i(?:'ve|\s+have)?|we(?:'ve|\s+have)?)\s+(?:finished|completed)\s+(?:everything|all(?:(?:\s+(?:tasks?|work)))?|the\s+work|the\s+plan)|(?:we(?:'re|\s+are)|i(?:'m|\s+am))\s+(?:all\s+)?done|nothing\s+left\s+to\s+do|todo\s+(?:está|esta)?\s*(?:listo|completo|terminado|hecho|finalizado)|(?:he|hemos|ya\s+he)\s+terminado\s+(?:todo|todas\s+las\s+tareas|el\s+trabajo)|todas\s+las\s+tareas\s+(?:están\s+)?(?:completadas|terminadas|hechas|listas)|ya\s+está\s+todo|todo\s+(?:completado|finalizado)|eso\s+es\s+todo|nada\s+más\s+que\s+hacer)\b/i;

// Negation / continuation signals that override a completion match:
// "the task is done, but I still need to…" should NOT resolve active tasks.
const CONTINUATION_PATTERN = /\b(?:still|not\s+(?:done|finished|complete(?:d)?|ready)|yet|remaining|remain|pending|(?:still|remains?|things?|more)\s+to\s+do|todo\s+(?:queda|falta|está\s+pendiente)|aún|todavía|falta|queda|pendiente|restante|siguiente\s+(?:paso|fase)|next\s+(?:step|phase))\b/i;

// Scope limits that turn a whole-work conclusion into a partial one:
// "all done with phase 1" should not drop tasks from later phases.
const SCOPE_LIMIT_PATTERN = /\b(?:this\s+(?:phase|step|part|sprint|batch|turn|milestone)|(?:phase|sprint|milestone)\s+\d+|for\s+now|so\s+far|de\s+momento|por\s+ahora|por\s+el\s+momento|esta\s+(?:fase|parte|etapa)|este\s+(?:paso|sprint|hito)|siguiente\s+(?:fase|etapa))\b/i;

export function detectGenericCompletion(text: string): boolean {
  if (CONTINUATION_PATTERN.test(text)) return false;
  return GENERIC_COMPLETION_PATTERN.test(text);
}

export function detectWorkConclusion(text: string): boolean {
  if (CONTINUATION_PATTERN.test(text) || SCOPE_LIMIT_PATTERN.test(text)) return false;
  return WORK_CONCLUSION_PATTERN.test(text);
}
