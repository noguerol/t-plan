
import type { PlanTask, PlanState, TaskStatus } from "./types.ts";
import { formatElapsed, tierBadge, tierColor } from "./tiers.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function generateId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function titleToProjectName(title: string): string {
  const stripped = title
    .replace(/^plan\s+de\s+/i, "")
    .replace(/^plan\s+/i, "")
    .replace(/\s+plan$/i, "")
    .replace(/^计划[：:\s]+/u, "")
    .replace(/\s*计划$/u, "")
    .trim();
  return stripped || title;
}

export function planFileNameFor(prefix: string, title: string, sessionId: string | undefined): string {
  const slug = slugify(titleToProjectName(title)) || "untitled";
  const id = sessionId ? sessionId.replace(/[^0-9a-zA-Z]/g, "").slice(0, 8) : "noid";
  return `${prefix}_${slug}_${id}.md`;
}

export interface ParsedPlanFileName {
  titleSlug: string;
    sessionId: string | undefined;
}

const SHORT_ID_RE = "[0-9a-zA-Z]{6,12}|noid";

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

export function deslugTitle(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

export type PlanLanguage = "en" | "es" | "zh";

const ES_ACCENTS = /[áéíóúñü¿¡]/gi;
const ES_WORDS = /\b(?:el|la|los|las|un|una|unos|unas|del|al|por|para|con|sin|que|como|pero|más|mas|ya|es|son|ser|este|esta|esto|tarea|tareas|paso|pasos|implementar|implementación|crear|creación|añadir|añadido|configurar|configuración|actualizar|revisar|arreglar|corregir|diseñar|arquitectura|autenticación|documento|documentación)\b/gi;
const EN_WORDS = /\b(?:the|and|for|with|from|that|this|these|those|of|to|into|task|tasks|step|steps|plan|implement|implementation|create|adding|add|update|review|fix|fixing|design|architecture|authentication|document|documentation|endpoint)\b/gi;
const ZH_CHARS = /[\u3400-\u9FFF]/g;
const ZH_WORDS = /(?:计划|任务|步骤|待办|完成|实现|添加|新增|创建|更新|修复|设计|架构|文档|配置|测试|接口|端点|模块|组件|审查|分析|调试|部署|安装|普通话|国语|中文|汉语)/g;

export function detectLanguage(text: string): PlanLanguage {
  if (!text) return "en";
  const accents = (text.match(ES_ACCENTS)?.length ?? 0) * 2;
  const esWords = text.match(ES_WORDS)?.length ?? 0;
  const enWords = text.match(EN_WORDS)?.length ?? 0;
  const zhChars = text.match(ZH_CHARS)?.length ?? 0;
  const zhWords = (text.match(ZH_WORDS)?.length ?? 0) * 2;
  const zhScore = zhChars + zhWords;
  if (zhScore >= 2 && zhScore > accents + esWords && zhScore > enWords) return "zh";
  return accents + esWords > enWords ? "es" : "en";
}

export function planTitle(projectName: string, lang: PlanLanguage): string {
  const name = projectName.trim() || "project";
  if (lang === "es") return `Plan de ${name}`;
  if (lang === "zh") return `${name} 计划`;
  return `${name} Plan`;
}

export function extractPlanTasks(text: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  const lines = text.split("\n");
  
  const patterns = [
    /^\s*(\d+)[.)、．]\s*(.+)$/,
    /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/,
    /^#{1,4}\s+(?:(?:Step|步骤)\s*(\d+)|第\s*(\d+)\s*步)[:：\s-]+(.+)$/i,
    /^\s*[-*]\s+(.+)$/,
  ];

  let inPlanSection = false;
  let planSectionFound = false;
  let currentStatus: TaskStatus = "pending";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingStatus = statusFromHeading(line);
    
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

    if (inPlanSection && /^#{1,2}\s+(?!(?:Step|步骤|第\s*\d+\s*步))/i.test(line) && planSectionFound) {
      if (!/^#{1,4}\s+(?:(?:Step|步骤)\s*\d+|第\s*\d+\s*步)/i.test(line)) {
        inPlanSection = false;
        currentStatus = "pending";
      }
    }

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

    const stepMatch = line.match(patterns[2]);
    if (stepMatch) {
      const step = parseInt(stepMatch[1] ?? stepMatch[2] ?? "0");
      const text = cleanTaskText(stepMatch[3] ?? "");
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
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

function isPlanSectionHeading(line: string): boolean {
  const heading = headingText(line);
  if (!heading) return false;
  return /^(?:Project\s+Plan|Plan|Implementation\s+Plan|Task\s+List|TODO|Steps|Action\s+Plan|Updated\s+Plan|Revised\s+Plan|Current\s+Plan|Remaining\s+Tasks|Pending\s+Tasks|Next\s+Steps|Backlog|Roadmap|Status|Estado|Plan\s+actualizado|Plan\s+revisado|Plan\s+actual|Tareas|Tareas\s+pendientes|Pr[oó]ximos\s+pasos|项目计划|计划|实施计划|任务列表|待办|步骤|行动计划|更新计划|修订计划|当前计划|剩余任务|待办任务|下一步|路线图|状态)/iu.test(heading);
}

function statusFromHeading(line: string): TaskStatus | undefined {
  const heading = headingText(line);
  if (!heading) return undefined;

  if (/^(?:Status|Estado)\b/i.test(heading) || /^状态[:：\s]?/u.test(heading)) return undefined;

  if (/(?:待办|待处理|未完成|剩余|下一步|接下来)/u.test(heading)) {
    return "pending";
  }
  if (/\b(?:done|completed|complete|finished|hech[oa]s?|completad[oa]s?|terminad[oa]s?)\b/i.test(heading) || /(?:已完成|完成|已办|办完|结束)/u.test(heading)) {
    return "done";
  }
  if (/\b(?:in[-\s]?progress|doing|active|started|en\s+progreso|en\s+curso|en\s+marcha)\b/i.test(heading) || /(?:进行中|处理中|正在|已开始|开始)/u.test(heading)) {
    return "in_progress";
  }
  if (/\b(?:blocked|stuck|deferred|waiting|bloquead[oa]s?|atascad[oa]s?|aplazad[oa]s?|esperando)\b/i.test(heading) || /(?:已阻塞|阻塞|卡住|搁置|等待)/u.test(heading)) {
    return "blocked";
  }
  if (/\b(?:pending|remaining|todo|next|upcoming|pendientes?|restantes?|pr[oó]xim[oa]s?)\b/i.test(heading)) {
    return "pending";
  }
  return undefined;
}

export function containsPlan(text: string): boolean {
  if (text.split("\n").some((line) => isPlanSectionHeading(line) || statusFromHeading(line))) {
    return true;
  }

  const numberedItems = text.match(/^\s*\d+[.)]\s+.+$/gm);
  if (numberedItems && numberedItems.length >= 3) {
    return true;
  }

  const checkboxItems = text.match(/^\s*[-*]\s+\[[ xX]\]\s+.+$/gm);
  if (checkboxItems && checkboxItems.length >= 3) {
    return true;
  }

  return false;
}

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

  lines.push("---");
  lines.push(`*Last updated: ${new Date(state.updatedAt).toLocaleString()}*`);
  lines.push("");
  lines.push("<!-- PRIVATE RUNTIME STATE — generated by the t-plan extension. Never commit or publish this file; keep it in your .gitignore. -->");

  return lines.join("\n");
}

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
  const tierValue = showTier ? task.tier : undefined;
  const rawTier = tierValue ? ` ${tierBadge(tierValue)}` : "";
  const tier = tierValue ? theme.fg?.(tierColor(tierValue), rawTier) ?? rawTier : "";

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

  const rawText = task.text.replace(/\s+/g, " ").trim();
  const suffixWidth = visibleWidth(tier) + visibleWidth(timer) + visibleWidth(agent);
  const textBudget = Math.max(8, lineBudget - headWidth - suffixWidth - 1);
  const truncatedText = truncateToWidth(rawText, textBudget, "…");
  const styled = styleText(truncatedText);
  return `${head}${styled}${tier}${timer}${agent}`;
}

export function parseDoneMarkers(text: string, tasks: PlanTask[]): string[] {
  const completedIds: string[] = [];
  
  const doneIdMatches = text.matchAll(/\[DONE:([^\]]+)\]/gi);
  for (const match of doneIdMatches) {
    const identifier = match[1];
    const taskById = tasks.find(t => t.id === identifier);
    if (taskById) {
      completedIds.push(taskById.id);
      continue;
    }
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

function isSummaryLine(text: string): boolean {
  if (/^(?:🔄|⏳|🚫|✅|📋|📈|⚡)\s*(?:In progress|Pending|Blocked|Completed|Progress|Status|进行中|待办|阻塞|已完成|完成|进度|状态)/iu.test(text)) {
    return true;
  }
  if (/^\d+\/\d+\s+(?:completed|已完成|完成)/iu.test(text)) {
    return true;
  }
  return false;
}

export function detectAgentTasks(text: string): Array<{ agentId: string; agentName: string; taskDescription: string }> {
  const agents: Array<{ agentId: string; agentName: string; taskDescription: string }> = [];
  
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

const COMPLETION_PATTERN = /(?:\b(?:done|complete|completed|finished|implemented|added|created|fixed|resolved|closed|landed|ready|accomplished|wrapped|pass(?:es|ed|ing)?|terminad[oa]|completad[oa]|hech[oa]|implementad[oa]|agregad[oa]|cread[oa]|arreglad[oa]|resuelt[oa]|a\u00f1adid[oa]|incluid[oa]|conseguid[oa]|listo)\b|(?:已完成|完成了|(?<!未)完成|做完|搞定|实现了|已实现|添加了|已添加|新增了|已新增|创建了|已创建|修复了|已修复|解决了|已解决|通过了|已通过|准备好了|就绪))/i;

const START_PATTERN = /(?:\b(?:start(?:ed|ing)?|working\s+on|work\s+on|in\s+progress|begin(?:ning)?|began|on\s+it|empezad[oa]|trabajando\s+en|en\s+progreso|comenzand[oa])\b|(?:开始|已开始|正在|着手|处理中|进行中|我来做|我在做))/i;

const TASK_NUMBER_REF = /(?:\b(?:task|step|item|point|tarea|paso)\s*#?\s*(\d+)\b|(?:任务|步骤|第)\s*#?\s*(\d+)\s*(?:项|步|条|点)?)/gi;

const DONE_LINE_PREFIX = /^\s*(?:[-*]\s+\[[xX]\]\s*|✅\s*|✔️\s*|☑️\s*|✓\s*|完成[:：]\s*|已完成[:：]\s*)(.+)$/;

const CJK_TEXT_RE = /[\u3400-\u9FFF]/u;
const WORD_OR_CJK_RE = /[a-z0-9áéíóúñü]+|[\u3400-\u9FFF]+/giu;

const STOPWORDS = new Set([
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
  "que", "para", "por", "con", "sin", "los", "las", "una", "unas", "unos",
  "del", "esta", "este", "esto", "ese", "esa", "eso", "pero", "como", "cuando",
  "donde", "muy", "bien", "todo", "toda", "cada", "entre", "hacia", "desde",
  "hasta", "durante", "tambien", "aunque", "porque", "pues", "ser", "estar",
  "haber", "tener", "hacer", "otro", "otra", "otros", "otras", "mas", "ya",
  "les", "sus", "mis", "tus", "nos", "vamos", "voy", "ver", "decir", "quiero",
  "puedo", "podemos", "vamos", "estoy", "esta", "estan", "tenemos", "hace",
  "的", "了", "和", "与", "及", "在", "是", "我", "我们", "你", "你们", "他", "她", "它",
  "这", "这个", "这些", "那", "那个", "那些", "就", "也", "都", "很", "更", "还", "要",
  "把", "被", "给", "对", "从", "到", "为", "并", "或", "而", "但", "如果", "然后",
]);

function stem(w: string): string {
  if (CJK_TEXT_RE.test(w) || w.length <= 4) return w;
  let s = w
    .replace(/(ingly|edly)$/, "")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/(ad[oa]s?|iend[oa]s?|and[oa]s?)$/, "")
    .replace(/(ar|er|ir)$/, "");
  return s.length < 3 ? w : s;
}

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
  完成: "complete", 已完成: "complete", 做完: "complete", 完毕: "complete", 搞定: "complete", 就绪: "ready",
  实现: "implement", 已实现: "implement", 实施: "implement",
  添加: "add", 新增: "add", 加入: "add", 增加: "add",
  创建: "create", 建立: "create", 编写: "write", 写入: "write",
  修复: "fix", 解决: "resolve", 更正: "fix", 纠正: "fix",
  更新: "update", 配置: "config", 设置: "config", 加载: "load", 保存: "save",
  删除: "remove", 移除: "remove", 去掉: "remove", 丢弃: "remove", 取消: "remove",
  查找: "search", 搜索: "search", 检索: "search",
  测试: "test", 验证: "test", 通过: "pass",
  任务: "task", 步骤: "step", 计划: "plan", 待办: "todo",
  文档: "document", 说明文档: "document", 架构: "architecture", 设计: "design",
  认证: "auth", 身份验证: "auth", 登录: "auth", 接口: "api", 端点: "endpoint",
  模块: "module", 组件: "component", 功能: "feature", 错误: "bug", 缺陷: "bug",
  模糊: "fuzzy", 匹配: "match", 检测: "detect", 识别: "detect",
  中文: "mandarin", 汉语: "mandarin", 普通话: "mandarin", 国语: "mandarin", 曼达林: "mandarin",
};

const ZH_SYNONYM_PHRASES = Object.keys(SYNONYMS).filter((key) => CJK_TEXT_RE.test(key)).sort((a, b) => b.length - a.length);

function normalizeToken(w: string): string {
  return SYNONYMS[w] ?? w;
}

function addCjkToken(tokens: Set<string>, chunk: string): void {
  const chars = [...chunk];
  if (chars.length >= 2 && !STOPWORDS.has(chunk)) tokens.add(normalizeToken(chunk));
  for (const phrase of ZH_SYNONYM_PHRASES) {
    if (chunk.includes(phrase)) tokens.add(SYNONYMS[phrase]);
  }
  for (const size of [2, 3]) {
    if (chars.length < size) continue;
    for (let i = 0; i <= chars.length - size; i++) {
      const gram = chars.slice(i, i + size).join("");
      if (!STOPWORDS.has(gram)) tokens.add(normalizeToken(gram));
    }
  }
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(WORD_OR_CJK_RE)) {
    const w = match[0];
    if (CJK_TEXT_RE.test(w)) {
      addCjkToken(tokens, w);
      continue;
    }
    if (w.length < 3) continue;
    const s = stem(w);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    tokens.add(normalizeToken(s));
  }
  return tokens;
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length > a.length && b.includes(a)) return true;
  if (b.length >= 4 && a.length > b.length && a.includes(b)) return true;
  return false;
}

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
  return /\b(?:updated|revised|current|new|remaining|pending|next\s+steps|todo|backlog|roadmap|replace|replan(?:ned)?|discard(?:ed|ing)?|drop(?:ped|ping)?|remove(?:d|ing)?|delete(?:d|ing)?|eliminate(?:d|ing)?|actualizad[oa]s?|actual|revisad[oa]s?|restantes?|pendientes?|pr[oó]ximos\s+pasos|descartad[oa]s?|eliminad[oa]s?|quitad[oa]s?|borrad[oa]s?)\b/i.test(text)
    || /(?:更新|修订|当前|新的?|剩余|待办|待处理|下一步|接下来|路线图|替换|重新计划|丢弃|删除|移除|去掉|取消)/u.test(text);
}

export function shouldRemoveMissingTasksFromPlan(text: string): boolean {
  return /\b(?:updated|revised|current|remaining|replace|replan(?:ned)?|clean\s+plan|backlog|roadmap|actualizad[oa]s?|actual|revisad[oa]s?|restantes?|pendientes?|descartad[oa]s?|eliminad[oa]s?|quitad[oa]s?|borrad[oa]s?|no\s+longer|out\s+of\s+scope|fuera\s+de\s+alcance|ya\s+no)\b/i.test(text)
    || /(?:更新|修订|当前|剩余|替换|重新计划|清理计划|路线图|丢弃|删除|移除|去掉|取消|不再需要|不需要|超出范围|范围之外)/u.test(text);
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

    if (options.removeMissing && task.status !== "done") {
      removed++;
      continue;
    }

    nextTasks.push({ ...task, order: appendStart + (nextTasks.length - appendStart) + 1 });
  }

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

const TASK_REMOVAL_PATTERN = /\b(?:discard(?:ed|ing)?|drop(?:ped|ping)?|delete(?:d|ing)?|eliminate(?:d|ing)?|remove(?:d|ing)?|descart(?:ad[oa]s?|o|amos|ando)|elimin(?:ad[oa]s?|o|amos|ando)|quit(?:ad[oa]s?|o|amos|ando)|borr(?:ad[oa]s?|o|amos|ando))\b.*\b(?:task|item|step|plan|tarea|paso|punto)\b|\b(?:task|item|step|tarea|paso|punto)\b.*\b(?:discarded|dropped|deleted|eliminated|removed|descartad[oa]s?|eliminad[oa]s?|quitad[oa]s?|borrad[oa]s?)\b|\b(?:no\s+longer\s+needed|not\s+needed|out\s+of\s+scope|ya\s+no\s+hace\s+falta|ya\s+no\s+es\s+necesari[oa]|fuera\s+de\s+alcance)\b|(?:丢弃|删除|移除|去掉|取消|淘汰).*(?:任务|步骤|计划|项目|事项)|(?:任务|步骤|计划|项目|事项).*(?:丢弃|删除|移除|去掉|取消|淘汰)|(?:不再需要|不需要|超出范围|范围之外)/i;

export function detectRemovedTasks(text: string, tasks: PlanTask[]): string[] {
  const removedIds: string[] = [];
  const removable = tasks.filter((t) => t.status !== "done");
  if (removable.length === 0) return removedIds;

  for (const segment of splitSegments(text)) {
    if (!TASK_REMOVAL_PATTERN.test(segment)) continue;

    for (const ref of segment.matchAll(TASK_NUMBER_REF)) {
      const order = parseInt(ref[1] ?? ref[2] ?? "0", 10);
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
  for (const part of text.split(/\n+|(?<=[.!?。！？])\s*/)) {
    const s = part.trim();
    if (s.length > 0 && s.length <= 300) segments.push(s);
  }
  return segments;
}

export interface AutoTransitions {
  completedIds: string[];
  startedIds: string[];
}

export function detectAutoTransitions(text: string, toolCorpus: string, tasks: PlanTask[]): AutoTransitions {
  const completedIds: string[] = [];
  const startedIds: string[] = [];

  const active = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  if (active.length === 0) return { completedIds, startedIds };

  for (const line of text.split(/\n+/)) {
    const m = line.match(DONE_LINE_PREFIX);
    if (!m) continue;
    const best = bestMatch(m[1], active, 0.5);
    if (best && !completedIds.includes(best.id)) completedIds.push(best.id);
  }

  const segments = splitSegments(text);

  for (const segment of segments) {
    if (!COMPLETION_PATTERN.test(segment)) continue;

    for (const ref of segment.matchAll(TASK_NUMBER_REF)) {
      const order = parseInt(ref[1] ?? ref[2] ?? "0", 10);
      const task = active.find((t) => t.order === order);
      if (task && !completedIds.includes(task.id)) completedIds.push(task.id);
    }

    for (const task of active) {
      if (completedIds.includes(task.id)) continue;
      if (taskTextScore(task.text, segment) >= 0.55) completedIds.push(task.id);
    }
  }

  for (const segment of segments) {
    if (!START_PATTERN.test(segment)) continue;
    const candidates = active.filter(
      (t) => t.status === "pending" && !completedIds.includes(t.id) && !startedIds.includes(t.id)
    );
    const best = bestMatch(segment, candidates, 0.5);
    if (best) startedIds.push(best.id);
  }

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

const GENERIC_COMPLETION_PATTERN = /\b(?:all\s+done|all\s+finished|all\s+complete(?:d)?|everything(?:(?:\s+(?:is|was))|(?:'s))?\s+(?:done|complete(?:d)?|finished|ready)|all\s+tasks?\s+(?:are\s+)?(?:done|complete(?:d)?|finished)|(?:the\s+)?work\s+is\s+(?:done|complete(?:d)?|finished)|that\s+(?:completes|concludes|wraps\s+up)|(?:i(?:'ve|\s+have)?|we(?:'ve|\s+have)?)\s+(?:finished|completed)\s+(?:everything|all(?:(?:\s+(?:tasks?|work)))?|the\s+work|the\s+task)|(?:the\s+)?task\s+is\s+(?:done|complete(?:d)?|finished)|todo\s+(?:está|esta)?\s*(?:listo|completo|terminado|hecho|finalizado)|(?:he|hemos|ya\s+he)\s+terminado\s+(?:todo|todas\s+las\s+tareas|el\s+trabajo|la\s+tarea)|(?:la\s+)?tarea\s+(?:está|esta)\s+(?:completada|terminada|hecha|lista|finalizada)|todas\s+las\s+tareas\s+(?:están\s+)?(?:completadas|terminadas|hechas|listas)|ya\s+está\s+todo|todo\s+(?:completado|finalizado)|eso\s+es\s+todo)\b/i;
const GENERIC_COMPLETION_ZH_PATTERN = /(?:任务|工作|事项)?(?:已完成|完成了|做完了|搞定了|结束了|准备好了|已就绪)|(?:我|我们)?(?:已经)?(?:(?<!未)完成|做完|搞定)(?:了)?(?:任务|工作|事项)?/u;

const WORK_CONCLUSION_PATTERN = /\b(?:all\s+done|all\s+finished|all\s+complete(?:d)?|everything(?:(?:\s+(?:is|was))|(?:'s))?\s+(?:done|complete(?:d)?|finished|ready)|all\s+tasks?\s+(?:are\s+)?(?:done|complete(?:d)?|finished)|(?:the\s+)?(?:work|plan|implementation)\s+is\s+(?:done|complete(?:d)?|finished)|that\s+(?:completes|concludes|wraps\s+up)(?:\s+(?:the\s+)?(?:work|plan|everything|it))?|(?:i(?:'ve|\s+have)?|we(?:'ve|\s+have)?)\s+(?:finished|completed)\s+(?:everything|all(?:(?:\s+(?:tasks?|work)))?|the\s+work|the\s+plan)|(?:we(?:'re|\s+are)|i(?:'m|\s+am))\s+(?:all\s+)?done|nothing\s+left\s+to\s+do|todo\s+(?:está|esta)?\s*(?:listo|completo|terminado|hecho|finalizado)|(?:he|hemos|ya\s+he)\s+terminado\s+(?:todo|todas\s+las\s+tareas|el\s+trabajo)|todas\s+las\s+tareas\s+(?:están\s+)?(?:completadas|terminadas|hechas|listas)|ya\s+está\s+todo|todo\s+(?:completado|finalizado)|eso\s+es\s+todo|nada\s+más\s+que\s+hacer|ya\s+est[áa](?:\s+(?:comitead[oa]|pushead[oa]|desplegad[oa]|publicad[oa]|subid[oa]|hech[oa]|list[oa]))?|ya\s+qued[oó]\s+(?:list[oa]|hech[oa])|(?:commit|push|deploy|release)\s+(?:done|ok|listo|hecho|exitos[oa]|publicado)|funcion[oó]\s+(?:bien|perfecto))\b/i;
const WORK_CONCLUSION_ZH_PATTERN = /(?:全部|所有|整个)(?:任务|工作|计划|实现)?(?:都)?(?:已完成|完成了|(?<!未)完成|做完了|搞定了|结束了|准备好了|已就绪)|(?:任务|工作|计划)(?:全部|都)(?:已完成|完成了|(?<!未)完成|做完了|搞定了|结束了)|(?:没有|没什么|无)(?:剩余|待办|要做)(?:的)?(?:任务|工作|事项)?|(?:已|已经)(?:搞定|做好|完成|部署|推送|提交|发布)(?:了)?|(?:就绪|好了)|(?:任务|工作|事项)?(?:已完成|完成了|做完了|搞定了|结束了|准备好了|已就绪)|(?:我|我们)?(?:已经)?(?:(?<!未)完成|做完|搞定)(?:了)?(?:任务|工作|事项)?/u;

const CONTINUATION_PATTERN = /\b(?:still|not\s+(?:done|finished|complete(?:d)?|ready)|yet|remaining|remain|pending|(?:still|remains?|things?|more)\s+to\s+do|todo\s+(?:queda|falta|está\s+pendiente)|aún|todavía|falta|queda|pendiente|restante|siguiente\s+(?:paso|fase)|next\s+(?:step|phase))\b/i;
const CONTINUATION_ZH_PATTERN = /(?:仍然|尚未|未完成|没完成|待办|待处理|剩余|还有|还需|还要|接下来|下一步|下一阶段|需要继续|继续)/u;

const SCOPE_LIMIT_PATTERN = /\b(?:this\s+(?:phase|step|part|sprint|batch|turn|milestone)|(?:phase|sprint|milestone)\s+\d+|for\s+now|so\s+far|de\s+momento|por\s+ahora|por\s+el\s+momento|esta\s+(?:fase|parte|etapa)|este\s+(?:paso|sprint|hito)|siguiente\s+(?:fase|etapa))\b/i;
const SCOPE_LIMIT_ZH_PATTERN = /(?:目前|暂时|到目前为止|现在先|这一(?:阶段|步|部分|批次)|这个(?:阶段|步骤|部分|批次)|第\s*\d+\s*(?:阶段|步|部分|批次)|下一(?:阶段|步))/u;

export function detectGenericCompletion(text: string): boolean {
  if (CONTINUATION_PATTERN.test(text) || CONTINUATION_ZH_PATTERN.test(text)) return false;
  return GENERIC_COMPLETION_PATTERN.test(text) || GENERIC_COMPLETION_ZH_PATTERN.test(text) || TOOL_OUTPUT_DONE_PATTERN.test(text);
}

const TOOL_OUTPUT_DONE_PATTERN = /\b(?:Everything\s+up-to-date|Already\s+up-to-date|nothing\s+to\s+commit,?\s+working\s+tree\s+clean|Your\s+branch\s+is\s+up\s+to\s+date(?:[^.\n]*?(?:with|behind)\s+['"]?(?:origin|upstream)['"]?(?:[^.\n]*?\/[A-Za-z0-9._-]+)?)?|0\s+files?\s+changed,?\s+0\s+insertions?\(\+\),?\s+0\s+deletions?\(-|build\s+succeeded|no\s+errors?\s+found|all\s+checks?\s+passed)\b/i;

export function detectWorkConclusion(text: string): boolean {
  if (CONTINUATION_PATTERN.test(text) || CONTINUATION_ZH_PATTERN.test(text) || SCOPE_LIMIT_PATTERN.test(text) || SCOPE_LIMIT_ZH_PATTERN.test(text)) return false;
  return WORK_CONCLUSION_PATTERN.test(text) || WORK_CONCLUSION_ZH_PATTERN.test(text) || TOOL_OUTPUT_DONE_PATTERN.test(text);
}
