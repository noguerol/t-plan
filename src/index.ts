/**
 * t-plan Extension for pi
 *
 * Manages implementation plans with task tracking, parallel agent support,
 * and persistent per-session plan files.
 *
 * Features:
 * - Auto-detect plans from model output
 * - Session-scoped plan file: <prefix>_<title-slug>_<session-id>.md —
 *   parallel pi instances in the same directory never collide, and any plan
 *   file traces back to the session that owns it (resume with pi --session)
 * - Localized plan title ("{project} Plan" / "Plan de {project}" /
 *   "{project} 计划") shown in the widget and used in the file name
 * - TUI widget showing task progress
 * - Parallel agent task tracking
 * - Trimegisto mode: classifies tasks into t1 (complex) / t2 (medium) /
 *   t3 (simple) tiers and shows which agent will run each one
 * - Elapsed-time counters (HH:MM:SS) for in-progress tasks
 * - /t-plan command family for management
 * - Manual task editing (add, remove, edit, reorder)
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { PlanTask, PlanState, PlanConfig, TaskStatus, Tier } from "./types.ts";
import { DEFAULT_CONFIG, DEFAULT_STATE, SPINNER_FRAMES } from "./types.ts";
import {
  classifyTask,
  completedTimerText,
  formatElapsed,
  isTierAvailable,
  readTrimegistoConfig,
  resolveEffectiveTier,
  TIER_ROLES,
  tierToToolValue,
  toolValueToTier,
  type TrimegistoFileConfig,
} from "./tiers.ts";
import {
  extractPlanTasks,
  containsPlan,
  generatePlanMarkdown,
  formatTaskForWidget,
  parseDoneMarkers,
  detectAgentTasks,
  detectAutoTransitions,
  detectGenericCompletion,
  detectWorkConclusion,
  detectRemovedTasks,
  reconcilePlanTasks,
  shouldReconcilePlan,
  shouldRemoveMissingTasksFromPlan,
  generateId,
  detectLanguage,
  deslugTitle,
  parsePlanFileName,
  planFileNameFor,
  planTitle,
  slugify,
  titleToProjectName,
} from "./utils.ts";
import { readFile, writeFile, access, unlink, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export default function planExtension(pi: ExtensionAPI): void {
  // State
  let config: PlanConfig = { ...DEFAULT_CONFIG };
  let state: PlanState = { ...DEFAULT_STATE, tasks: [] };
  let planFilePath: string = "";
  let widgetVisible = false;
  let widgetAnimationTimer: NodeJS.Timeout | undefined;
  let spinnerFrame = 0;
  const highlightedTasks = new Map<string, number>();
  const highlightTimers = new Set<NodeJS.Timeout>();
  // Cached trimegisto config (tier availability) — refreshed on session start
  // and whenever Trimegisto mode is toggled.
  let tgConfig: TrimegistoFileConfig | null = null;
  // Global (cross-session) preferences from ~/.pi/agent/t-plan/config.json
  let globalConfigPartial: Partial<PlanConfig> = {};
  // Current pi session id + the plan file last written for this session.
  // Each session owns its plan file: <prefix>_<title-slug>_<session-id>.md
  let sessionId: string | undefined;
  let lastPlanFile: string | undefined;

  // ─── Global config file ───────────────────────────────────────────────

  const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "t-plan", "config.json");

  async function loadGlobalConfig(): Promise<Partial<PlanConfig>> {
    try {
      const raw = await readFile(GLOBAL_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.config === "object" && parsed.config !== null) {
        return parsed.config as Partial<PlanConfig>;
      }
    } catch {
      // missing or corrupt file — start from defaults
    }
    return {};
  }

  function saveGlobalConfig(): void {
    // Sticky settings across sessions (session entries still override these
    // when newer). Best-effort: never throws.
    mkdir(dirname(GLOBAL_CONFIG_PATH), { recursive: true }).catch(() => {});
    writeFile(GLOBAL_CONFIG_PATH, JSON.stringify({ config }, null, 2), "utf-8").catch(() => {});
  }

  // ─── Persistence ──────────────────────────────────────────────────────

  function persistState(): void {
    pi.appendEntry("plan-state", {
      config,
      state,
    });
    saveGlobalConfig();
  }

  function restoreState(entries: any[]): void {
    const planEntry = entries
      .filter((e: any) => e.type === "custom" && e.customType === "plan-state")
      .pop() as { data?: { config?: PlanConfig; state?: PlanState } } | undefined;

    if (planEntry?.data) {
      if (planEntry.data.config) {
        // Precedence: session entry (newest) > global file > defaults.
        const merged = { ...DEFAULT_CONFIG, ...globalConfigPartial, ...planEntry.data.config } as PlanConfig & { planFileName?: string };
        // v2 → v3 migration: planFileName (a full file name) became a prefix.
        const saved = planEntry.data.config as PlanConfig & { planFileName?: string };
        if (typeof saved.planFileName === "string" && saved.planFileName && saved.planFilePrefix === undefined) {
          merged.planFilePrefix = saved.planFileName.replace(/\.md$/i, "");
        }
        delete merged.planFileName;
        config = merged;
      }
      if (planEntry.data.state) {
        const savedState = planEntry.data.state as PlanState & { titleAuto?: boolean };
        state = { ...DEFAULT_STATE, ...savedState };
        // v2 sessions have no titleAuto: treat a meaningful title as custom.
        if (savedState.titleAuto === undefined) {
          state.titleAuto = !(savedState.title && savedState.title !== "Project Plan");
        }
        if (state.title === "Project Plan") {
          state.title = "";
          state.titleAuto = true;
        }
      }
    }
  }

  /** Derive the localized default title ("{project} Plan" / "Plan de {project}" /
   *  "{project} 计划") from the working directory + the language of the given sample text.
   *  Never overrides a user-set title (titleAuto === false). */
  function ensureTitle(sampleText: string | undefined, ctx?: ExtensionContext): void {
    if (!state.titleAuto) return;
    const project = ctx ? basename(ctx.cwd) : "project";
    const lang = sampleText ? detectLanguage(sampleText) : "en";
    const next = planTitle(project, lang);
    if (state.title !== next) {
      state.title = next;
      state.updatedAt = Date.now();
    }
  }

  // ─── File Operations ──────────────────────────────────────────────────

  async function writePlanFile(cwd: string): Promise<void> {
    if (!config.enabled || state.tasks.length === 0) return;

    // Session-scoped file: <prefix>_<title-slug>_<session-id>.md — parallel pi
    // instances in this directory never collide.
    const fileName = planFileNameFor(config.planFilePrefix, state.title, sessionId);
    const filePath = join(cwd, fileName);
    // Title changed → this session's plan file moves; drop the stale one.
    if (lastPlanFile && lastPlanFile !== filePath) {
      try {
        await unlink(lastPlanFile);
      } catch {
        // already gone
      }
    }
    // plan.md shows the EFFECTIVE tier (after availability fallback).
    const displayState: PlanState = config.trimegisto
      ? { ...state, tasks: state.tasks.map((t) => ({ ...t, tier: resolveEffectiveTier(t.tier, tgConfig) })) }
      : state;
    const content = generatePlanMarkdown(displayState, {
      trimegisto: config.trimegisto,
      showTimers: config.showTimers,
    });

    try {
      await writeFile(filePath, content, "utf-8");
      planFilePath = filePath;
      lastPlanFile = filePath;
      // Safety net: plan files must never be committed or published.
      await ensurePlanFileGitIgnored(cwd, config.planFilePrefix);
    } catch (err) {
      // Silent fail - file write is best-effort
    }
  }

  async function readPlanFile(cwd: string): Promise<boolean> {
    const filePath = join(cwd, planFileNameFor(config.planFilePrefix, state.title, sessionId));

    try {
      await access(filePath);
      const content = await readFile(filePath, "utf-8");
      const tasks = extractPlanTasks(content);
      if (tasks.length > 0) {
        state.tasks = tasks;
        state.updatedAt = Date.now();
        planFilePath = filePath;
        lastPlanFile = filePath;
        return true;
      }
    } catch {
      // File doesn't exist or can't be read
    }
    return false;
  }

  /** Walk up from `start` looking for a git working-tree root (`.git` dir or
   *  worktree file), bounded to avoid climbing the whole filesystem. */
  async function findGitRoot(start: string): Promise<string | undefined> {
    let dir = start;
    for (let i = 0; i < 12; i++) {
      try {
        await access(join(dir, ".git"));
        return dir;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    }
    return undefined;
  }

  /** Best-effort, idempotent: keep generated plan files out of version control.
   *
   *  Plan files are PRIVATE runtime state — they must never be committed or
   *  published. Because the session-scoped name embeds a per-session id
   *  (plan_<title>_<session-id>.md), a fixed-filename rule like `plan.md` is not
   *  enough: the .gitignore entry has to be a pattern that covers the whole
   *  family (<prefix>_*_[0-9a-zA-Z]*.md).
   *
   *  This is a safety net, not a requirement: never throws, and does nothing
   *  when the working directory is not inside a git repository.
   */
  async function ensurePlanFileGitIgnored(cwd: string, prefix: string): Promise<void> {
    try {
      const gitRoot = await findGitRoot(cwd);
      if (!gitRoot) return; // not inside a git repository — nothing to protect
      const gitignorePath = join(gitRoot, ".gitignore");
      let content = "";
      try {
        content = await readFile(gitignorePath, "utf-8");
      } catch {
        // no .gitignore yet — create one below
      }
      const patterns = [`${prefix}_*_[0-9a-zA-Z]*.md`];
      if (prefix === "plan") patterns.push("plan.md"); // legacy single-file plans
      const lines = content.split("\n");
      const missing = patterns.filter((p) => !lines.some((l) => l.trim() === p));
      if (missing.length === 0) return; // already covered
      const header = "# t-plan: plan files are private runtime state — never commit or publish them";
      const block = [header, ...missing, ""].join("\n");
      const next = content.length === 0 || content.endsWith("\n") ? content + block : content + "\n" + block;
      await writeFile(gitignorePath, next, "utf-8");
    } catch {
      // best-effort — never throw
    }
  }

  // ─── UI Updates ───────────────────────────────────────────────────────

  function startWidgetAnimation(ctx: ExtensionContext): void {
    const anyInProgress = state.tasks.some((t) => t.status === "in_progress");
    const anyActivity = anyInProgress || highlightedTasks.size > 0;
    const wantSpin = config.animateWidget;
    const wantTimer = config.showTimers && anyInProgress;
    // Animate when spinners/highlights want frames, or when timers need
    // 1-second refreshes (even with widget animation disabled).
    const shouldAnimate = config.enabled && config.showWidget && anyActivity && (wantSpin || wantTimer);

    if (!shouldAnimate) {
      stopWidgetAnimation();
      return;
    }
    if (widgetAnimationTimer) return; // already running

    const interval = wantSpin ? 160 : 1000;
    widgetAnimationTimer = setInterval(() => {
      try {
        if (wantSpin) spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        updateUI(ctx);
      } catch {
        // The session was replaced/reloaded; drop the stale timer.
        stopWidgetAnimation();
      }
    }, interval);
  }

  function stopWidgetAnimation(): void {
    if (widgetAnimationTimer) {
      clearInterval(widgetAnimationTimer);
      widgetAnimationTimer = undefined;
    }
  }

  function stopAllTimers(): void {
    stopWidgetAnimation();
    for (const timer of highlightTimers) clearInterval(timer);
    highlightTimers.clear();
    highlightedTasks.clear();
  }

  function highlightTask(task: PlanTask, ctx: ExtensionContext): void {
    if (!config.highlightCompleted) return;
    highlightedTasks.set(task.id, Date.now());
    const start = Date.now();
    const timer = setInterval(() => {
      try {
        if (Date.now() - start >= 2400 || !highlightedTasks.has(task.id)) {
          clearInterval(timer);
          highlightTimers.delete(timer);
          highlightedTasks.delete(task.id);
          updateUI(ctx);
        }
      } catch {
        // Session replaced/reloaded; drop the stale timer.
        clearInterval(timer);
        highlightTimers.delete(timer);
      }
    }, 200);
    highlightTimers.add(timer);
  }

  function updateUI(ctx: ExtensionContext): void {
    if (!config.enabled || !config.showWidget) {
      stopWidgetAnimation();
      ctx.ui.setStatus("t-plan", undefined);
      ctx.ui.setWidget("t-plan-tasks", undefined);
      widgetVisible = false;
      return;
    }

    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.status === "done").length;
    const inProgress = state.tasks.filter((t) => t.status === "in_progress").length;

    // Footer status
    if (total > 0) {
      const progress = `${done}/${total}`;
      const active = inProgress > 0 ? ` ${SPINNER_FRAMES[spinnerFrame]}${inProgress}` : "";
      ctx.ui.setStatus("t-plan", ctx.ui.theme.fg("accent", `📋 ${progress}${active}`));
    } else {
      ctx.ui.setStatus("t-plan", ctx.ui.theme.fg("muted", "📋 no plan"));
    }

    // Widget with task list
    if (total > 0 && state.showWidget) {
      const now = Date.now();
      for (const [id, start] of highlightedTasks) {
        if (now - start >= 2400) highlightedTasks.delete(id);
      }

      const maxVisible = 5;

      // Effective tier: the tier a task will ACTUALLY run on (after
      // availability fallback), or undefined when trimegisto mode is off.
      const withTier = (t: PlanTask): PlanTask =>
        config.trimegisto ? { ...t, tier: resolveEffectiveTier(t.tier, tgConfig) } : t;

      // In-progress first (with spinner), then blocked, then upcoming in
      // priority (order) — matching how the user wants to read the plan.
      const active = state.tasks
        .filter((t) => t.status === "in_progress" || t.status === "blocked")
        .sort((a, b) => a.order - b.order)
        .map(withTier);

      const upcoming = state.tasks
        .filter((t) => t.status === "pending")
        .sort((a, b) => a.order - b.order)
        .map(withTier);

      // Recently completed tasks flash briefly at the bottom before fading out.
      const completed = state.tasks
        .filter((t) => t.status === "done" && highlightedTasks.has(t.id))
        .sort((a, b) => (highlightedTasks.get(b.id) ?? 0) - (highlightedTasks.get(a.id) ?? 0))
        .slice(0, maxVisible)
        .map(withTier);

      const visibleTasks = [...active, ...upcoming, ...completed].slice(0, maxVisible);
      const remainingCount = Math.max(0, active.length + upcoming.length + completed.length - visibleTasks.length);

      // Compact per-tier distribution of open (non-done) tasks.
      let tierSummary = "";
      if (config.trimegisto) {
        const counts: Partial<Record<Tier, number>> = {};
        for (const t of state.tasks) {
          if (t.status === "done") continue;
          const tier = resolveEffectiveTier(t.tier, tgConfig);
          counts[tier] = (counts[tier] ?? 0) + 1;
        }
        const parts = (["t1", "t2", "t3", "t0"] as Tier[])
          .filter((tier) => (counts[tier] ?? 0) > 0)
          .map((tier) => `${tier}×${counts[tier]}`);
        if (parts.length > 0) tierSummary = ` • ${parts.join(" ")}`;
      }

      const lines: string[] = [
        truncateToWidth(
          ctx.ui.theme.bold(ctx.ui.theme.fg("accent", `📋 ${state.title || "Plan"}`)) +
            `  ${ctx.ui.theme.fg("muted", `${done}/${total} done${inProgress > 0 ? ` • ${inProgress} active` : ""}${tierSummary}`)}`,
          78,
          "…"
        ),
      ];

      if (visibleTasks.length === 0) {
        lines.push(ctx.ui.theme.fg("muted", "  all done"));
      } else {
        lines.push("");
        const lineBudget = 75;
        for (const task of visibleTasks) {
          lines.push(
            formatTaskForWidget(ctx, task, {
              lineBudget,
              highlight: highlightedTasks.has(task.id),
              spinnerFrame,
              compact: config.compactTaskLines,
              showTier: config.trimegisto,
              showTimers: config.showTimers,
              now,
            })
          );
        }
        if (remainingCount > 0) {
          lines.push(truncateToWidth(ctx.ui.theme.fg("muted", `  ... ${remainingCount} more`), 78, "…"));
        }
      }

      ctx.ui.setWidget("t-plan-tasks", lines, { placement: config.widgetPlacement });
      widgetVisible = true;
      startWidgetAnimation(ctx);
    } else {
      stopWidgetAnimation();
      ctx.ui.setWidget("t-plan-tasks", undefined);
      widgetVisible = false;
    }
  }

  // ─── Task Management ──────────────────────────────────────────────────

  function addTask(text: string, status: TaskStatus = "pending", order?: number, tier?: Tier): PlanTask {
    const task: PlanTask = {
      id: generateId(),
      text,
      status,
      order: order ?? state.tasks.length + 1,
    };
    if (tier) {
      task.tier = tier;
    } else if (config.trimegisto) {
      // Trimegisto mode: auto-classify complexity (t1 complex / t2 medium / t3 simple).
      task.tier = classifyTask(text);
    }
    state.tasks.push(task);
    state.updatedAt = Date.now();
    return task;
  }

  function removeTask(taskId: string): boolean {
    const index = state.tasks.findIndex((t) => t.id === taskId);
    if (index === -1) return false;
    state.tasks.splice(index, 1);
    // Reorder remaining
    state.tasks.forEach((t, i) => (t.order = i + 1));
    state.updatedAt = Date.now();
    return true;
  }

  function updateTask(taskId: string, updates: Partial<PlanTask>): boolean {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return false;
    Object.assign(task, updates);
    state.updatedAt = Date.now();
    return true;
  }

  function moveTask(taskId: string, newOrder: number): boolean {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return false;

    const oldOrder = task.order;
    if (oldOrder === newOrder) return true;

    // Adjust other tasks
    if (newOrder < oldOrder) {
      state.tasks
        .filter((t) => t.order >= newOrder && t.order < oldOrder)
        .forEach((t) => t.order++);
    } else {
      state.tasks
        .filter((t) => t.order > oldOrder && t.order <= newOrder)
        .forEach((t) => t.order--);
    }

    task.order = newOrder;
    state.updatedAt = Date.now();
    return true;
  }

  function markTaskStatus(taskId: string, status: TaskStatus, ctx?: ExtensionContext): boolean {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return false;

    task.status = status;
    if (status === "in_progress") {
      task.startedAt = Date.now();
    } else if (status === "done") {
      task.completedAt = Date.now();
      if (ctx) highlightTask(task, ctx);
    } else {
      highlightedTasks.delete(task.id);
      if (status === "pending") task.startedAt = undefined;
    }
    state.updatedAt = Date.now();
    return true;
  }

  // ─── Agent Tracking ───────────────────────────────────────────────────

  function trackAgentTask(agentId: string, agentName: string, taskText: string): void {
    // Check if agent already has a task
    const existing = state.tasks.find((t) => t.agentId === agentId);
    if (existing) {
      existing.text = taskText;
      existing.agentName = agentName;
      existing.status = "in_progress";
    } else {
      const task = addTask(taskText, "in_progress");
      task.agentId = agentId;
      task.agentName = agentName;
      task.startedAt = Date.now();
    }
    state.updatedAt = Date.now();
  }

  function completeAgentTask(agentId: string): void {
    const task = state.tasks.find((t) => t.agentId === agentId);
    if (task) {
      task.status = "done";
      task.completedAt = Date.now();
      state.updatedAt = Date.now();
    }
  }

  // ─── Plan File Picker (cross-session plan recovery) ───────────────────

  interface PlanFileCandidate {
    file: string;
    name: string;
    title: string;
    sessionId: string | undefined;
    mtimeMs: number;
    taskCount: number;
    isCurrentSession: boolean;
  }

  /** Scan the working directory for session-scoped plan files (+ legacy
   *  <prefix>.md), newest first. */
  async function scanPlanFiles(ctx: ExtensionContext): Promise<PlanFileCandidate[]> {
    const out: PlanFileCandidate[] = [];
    let names: string[] = [];
    try {
      names = await readdir(ctx.cwd);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const parsed = parsePlanFileName(name, config.planFilePrefix);
      const legacy = name === `${config.planFilePrefix}.md`;
      if (!parsed && !legacy) continue;
      const path = join(ctx.cwd, name);
      try {
        const st = await stat(path);
        const content = await readFile(path, "utf-8");
        const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const title = h1 || (parsed ? deslugTitle(parsed.titleSlug) : config.planFilePrefix);
        const tasks = extractPlanTasks(content);
        out.push({
          file: path,
          name,
          title,
          sessionId: parsed?.sessionId,
          mtimeMs: st.mtimeMs,
          taskCount: tasks.length,
          isCurrentSession: !!parsed?.sessionId && !!sessionId && parsed.sessionId === sessionId.slice(0, 8),
        });
      } catch {
        // unreadable — skip
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** Interactive picker over all plan files in the directory. Loading a plan
   *  from ANOTHER session adopts its tasks+title here and hints how to resume
   *  the owning session with `pi --session <id>`. */
  async function pickAndLoadPlan(ctx: ExtensionContext): Promise<void> {
    const candidates = await scanPlanFiles(ctx);
    if (candidates.length === 0) {
      ctx.ui.notify(`No plan files (${config.planFilePrefix}_*.md) in ${ctx.cwd}`, "warning");
      return;
    }

    const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const labels = candidates.map((c, i) => {
      const mark = c.isCurrentSession ? " ← current" : "";
      const sess = c.sessionId ? ` · session ${c.sessionId}` : "";
      return `${i + 1}. ${c.title}${mark}${sess} · ${c.taskCount} tasks · ${fmt.format(c.mtimeMs)}`;
    });
    const choice = await ctx.ui.select("Load plan:", labels);
    if (!choice) return;

    const target = candidates[Number.parseInt(choice, 10) - 1];
    if (!target) return;

    try {
      const content = await readFile(target.file, "utf-8");
      const tasks = extractPlanTasks(content);
      if (tasks.length === 0) {
        ctx.ui.notify(`No tasks found in ${target.name}`, "warning");
        return;
      }
      const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (h1) {
        state.title = h1;
        state.titleAuto = false; // adopted title belongs to that project
      }
      state.tasks = tasks;
      state.updatedAt = Date.now();
      lastPlanFile = target.isCurrentSession ? target.file : undefined;
      updateUI(ctx);
      persistState();
      await writePlanFile(ctx.cwd);
      ctx.ui.notify(`Loaded ${tasks.length} tasks from ${target.name}`, "info");
      if (target.sessionId && sessionId && target.sessionId !== sessionId.slice(0, 8)) {
        ctx.ui.notify(
          `This plan belongs to session ${target.sessionId} — resume it with: pi --session ${target.sessionId}`,
          "info"
        );
      }
    } catch (err) {
      ctx.ui.notify(`Could not read ${target.name}`, "error");
    }
  }

  // ─── Commands ─────────────────────────────────────────────────────────

  // Main /t-plan command - toggle or show status
  pi.registerCommand("t-plan", {
    description: "Toggle t-plan tracking or show plan status",
    handler: async (args, ctx) => {
      const subcommand = args?.trim().toLowerCase();

      if (subcommand === "config") {
        await showConfigMenu(ctx);
        return;
      }

      if (subcommand === "on" || subcommand === "enable") {
        config.enabled = true;
        state.enabled = true;
        ctx.ui.notify("Plan tracking enabled", "info");
        updateUI(ctx);
        persistState();
        return;
      }

      if (subcommand === "off" || subcommand === "disable") {
        config.enabled = false;
        state.enabled = false;
        ctx.ui.notify("Plan tracking disabled", "info");
        updateUI(ctx);
        persistState();
        return;
      }

      if (subcommand === "show" || subcommand === "list" || subcommand === "status") {
        showPlanStatus(ctx);
        return;
      }

      if (subcommand === "new") {
        ensureTitle(undefined, ctx);
        const title = await ctx.ui.input("Plan title:", state.title);
        if (title) {
          state.title = title;
          state.titleAuto = false; // user owns this title now
          state.tasks = [];
          state.createdAt = Date.now();
          state.updatedAt = Date.now();
          lastPlanFile = undefined; // next write lands on the new title's file
          ctx.ui.notify(`New plan created: ${title}`, "info");
          updateUI(ctx);
          persistState();
        }
        return;
      }

      if (subcommand === "load") {
        await pickAndLoadPlan(ctx);
        updateUI(ctx);
        return;
      }

      if (subcommand === "save" || subcommand === "export") {
        await writePlanFile(ctx.cwd);
        ctx.ui.notify(`Plan saved to ${planFileNameFor(config.planFilePrefix, state.title, sessionId)}`, "info");
        return;
      }

      if (subcommand === "clear") {
        const ok = await ctx.ui.confirm("Clear plan?", "Remove all tasks from the current plan?");
        if (ok) {
          state.tasks = [];
          state.updatedAt = Date.now();
          ctx.ui.notify("Plan cleared", "info");
          updateUI(ctx);
          persistState();
        }
        return;
      }

      if (subcommand === "purge") {
        const ok = await ctx.ui.confirm(
          "Purge plan?",
          "Delete ALL tasks, reset plan state, and remove this session's plan file. This cannot be undone."
        );
        if (ok) {
          state = {
            ...DEFAULT_STATE,
            tasks: [],
            title: DEFAULT_STATE.title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          // Keep config preferences, but drop the persisted plan so it does
          // not come back on the next session restart.
          try {
            await unlink(join(ctx.cwd, planFileNameFor(config.planFilePrefix, state.title, sessionId)));
            lastPlanFile = undefined;
          } catch {
            // plan file may not exist
          }
          planFilePath = "";
          ctx.ui.notify("Plan purged: tasks, state, and plan file removed", "info");
          updateUI(ctx);
          persistState();
        }
        return;
      }

      // Default: toggle
      config.enabled = !config.enabled;
      state.enabled = config.enabled;
      ctx.ui.notify(`Plan tracking ${config.enabled ? "enabled" : "disabled"}`, "info");
      updateUI(ctx);
      persistState();
    },
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { value: "on", label: "on", description: "Enable plan tracking" },
        { value: "off", label: "off", description: "Disable plan tracking" },
        { value: "config", label: "config", description: "Open configuration" },
        { value: "show", label: "show", description: "Show current plan" },
        { value: "new", label: "new", description: "Create new plan" },
        { value: "load", label: "load", description: "Pick a plan file in this directory to load" },
        { value: "save", label: "save", description: "Save plan to this session's plan file" },
        { value: "clear", label: "clear", description: "Clear all tasks" },
        { value: "purge", label: "purge", description: "Purge plan: delete all tasks and this session's plan file" },
      ];
      const filtered = subcommands.filter((s) => s.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
  });

  // /task command - manage individual tasks
  pi.registerCommand("task", {
    description: "Manage plan tasks (add, done, remove, edit, move)",
    handler: async (args, ctx) => {
      if (!config.enabled) {
        ctx.ui.notify("Plan tracking is disabled. Use /plan on to enable.", "warning");
        return;
      }

      const parts = args?.trim().split(/\s+/) || [];
      const action = parts[0]?.toLowerCase();

      if (action === "add" || !action) {
        const text = action ? parts.slice(1).join(" ") : "";
        if (!text) {
          const input = await ctx.ui.input("Task description:", "");
          if (!input) return;
          ensureTitle(input, ctx);
          addTask(input);
        } else {
          ensureTitle(text, ctx);
          addTask(text);
        }
        ctx.ui.notify("Task added", "info");
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "done" || action === "complete") {
        const identifier = parts[1];
        if (!identifier) {
          // Show selection
          const pending = state.tasks.filter((t) => t.status !== "done");
          if (pending.length === 0) {
            ctx.ui.notify("No pending tasks", "info");
            return;
          }
          const choice = await ctx.ui.select(
            "Mark as done:",
            pending.map((t) => `${t.order}. ${t.text}`)
          );
          if (choice) {
            const order = parseInt(choice);
            const task = state.tasks.find((t) => t.order === order);
            if (task) {
              markTaskStatus(task.id, "done", ctx);
              ctx.ui.notify(`Completed: ${task.text}`, "info");
            }
          }
        } else {
          const task = findTaskByIdentifier(identifier);
          if (task) {
            markTaskStatus(task.id, "done", ctx);
            ctx.ui.notify(`Completed: ${task.text}`, "info");
          } else {
            ctx.ui.notify(`Task not found: ${identifier}`, "error");
          }
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "remove" || action === "delete" || action === "rm") {
        const identifier = parts[1];
        if (!identifier) {
          const choice = await ctx.ui.select(
            "Remove task:",
            state.tasks.map((t) => `${t.order}. ${t.text}`)
          );
          if (choice) {
            const order = parseInt(choice);
            const task = state.tasks.find((t) => t.order === order);
            if (task) {
              removeTask(task.id);
              ctx.ui.notify("Task removed", "info");
            }
          }
        } else {
          const task = findTaskByIdentifier(identifier);
          if (task) {
            removeTask(task.id);
            ctx.ui.notify("Task removed", "info");
          } else {
            ctx.ui.notify(`Task not found: ${identifier}`, "error");
          }
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "edit") {
        const identifier = parts[1];
        const task = identifier ? findTaskByIdentifier(identifier) : undefined;
        if (!task) {
          const choice = await ctx.ui.select(
            "Edit task:",
            state.tasks.map((t) => `${t.order}. ${t.text}`)
          );
          if (choice) {
            const order = parseInt(choice);
            const t = state.tasks.find((t) => t.order === order);
            if (t) {
              const newText = await ctx.ui.input("New text:", t.text);
              if (newText) {
                updateTask(t.id, { text: newText });
                ctx.ui.notify("Task updated", "info");
              }
            }
          }
        } else {
          const newText = await ctx.ui.input("New text:", task.text);
          if (newText) {
            updateTask(task.id, { text: newText });
            ctx.ui.notify("Task updated", "info");
          }
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "move" || action === "reorder") {
        const identifier = parts[1];
        const newOrderStr = parts[2];
        const task = identifier ? findTaskByIdentifier(identifier) : undefined;

        if (!task) {
          await showReorderUI(ctx);
        } else if (newOrderStr) {
          const newOrder = parseInt(newOrderStr);
          if (!isNaN(newOrder)) {
            moveTask(task.id, newOrder);
            ctx.ui.notify(`Moved to position ${newOrder}`, "info");
          }
        } else {
          const input = await ctx.ui.input("New position:", task.order.toString());
          if (input) {
            const newOrder = parseInt(input);
            if (!isNaN(newOrder)) {
              moveTask(task.id, newOrder);
              ctx.ui.notify(`Moved to position ${newOrder}`, "info");
            }
          }
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "start" || action === "begin") {
        const identifier = parts[1];
        const task = identifier ? findTaskByIdentifier(identifier) : undefined;
        if (!task) {
          const pending = state.tasks.filter((t) => t.status === "pending");
          if (pending.length > 0) {
            const choice = await ctx.ui.select(
              "Start task:",
              pending.map((t) => `${t.order}. ${t.text}`)
            );
            if (choice) {
              const order = parseInt(choice);
              const t = state.tasks.find((t) => t.order === order);
              if (t) {
                markTaskStatus(t.id, "in_progress", ctx);
                ctx.ui.notify(`Started: ${t.text}`, "info");
              }
            }
          }
        } else {
          markTaskStatus(task.id, "in_progress", ctx);
          ctx.ui.notify(`Started: ${task.text}`, "info");
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "block") {
        const identifier = parts[1];
        const reason = parts.slice(2).join(" ");
        const task = identifier ? findTaskByIdentifier(identifier) : undefined;
        if (task) {
          markTaskStatus(task.id, "blocked", ctx);
          if (reason) updateTask(task.id, { notes: reason });
          ctx.ui.notify(`Blocked: ${task.text}`, "info");
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "tier") {
        const identifier = parts[1];
        const rawTier = parts[2];
        const task = identifier ? findTaskByIdentifier(identifier) : undefined;

        const pickTier = async (): Promise<Tier | undefined> => {
          if (rawTier) {
            const parsed = toolValueToTier(rawTier);
            if (!parsed) {
              ctx.ui.notify("Invalid tier. Use t0 (active), t1, t2 or t3.", "error");
              return undefined;
            }
            return parsed;
          }
          const pick = await ctx.ui.select("Trimegisto tier:", ["t0 (active)", "t1 (complex)", "t2 (medium)", "t3 (simple)"]);
          if (!pick) return undefined;
          return toolValueToTier(pick.split(" ")[0]);
        };

        if (task) {
          const tier = await pickTier();
          if (tier) {
            updateTask(task.id, { tier });
            ctx.ui.notify(`Task ${task.order} → ${tier}${tier === "t0" ? " (active)" : ""}`, "info");
          }
        } else {
          const choice = await ctx.ui.select(
            "Set tier for task:",
            state.tasks.map((t) => `${t.order}. ${t.text}`)
          );
          if (choice) {
            const order = parseInt(choice);
            const t = state.tasks.find((x) => x.order === order);
            if (t) {
              const tier = await pickTier();
              if (tier) {
                updateTask(t.id, { tier });
                ctx.ui.notify(`Task ${t.order} → ${tier}${tier === "t0" ? " (active)" : ""}`, "info");
              }
            }
          }
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      // Show help
      ctx.ui.notify(
        `Usage: /task <action> [args]
  add [text]     - Add new task
  done [id]      - Mark task as done
  remove [id]    - Remove task
  edit [id]      - Edit task text
  move [id] [n]  - Move task to position
  start [id]     - Mark as in progress
  block [id] [reason] - Mark as blocked
  tier [id] [t0-t3]   - Set trimegisto tier (t0=active, t1=complex, t2=medium, t3=simple)`,
        "info"
      );
    },
    getArgumentCompletions: (prefix: string) => {
      const actions = [
        { value: "add", label: "add", description: "Add new task" },
        { value: "done", label: "done", description: "Mark as done" },
        { value: "remove", label: "remove", description: "Remove task" },
        { value: "edit", label: "edit", description: "Edit task text" },
        { value: "move", label: "move", description: "Reorder task" },
        { value: "start", label: "start", description: "Start task" },
        { value: "block", label: "block", description: "Block task" },
        { value: "tier", label: "tier", description: "Set trimegisto tier (t0/t1/t2/t3)" },
      ];
      const filtered = actions.filter((a) => a.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
  });

  // Helper to find task by ID, order number, or partial text
  function findTaskByIdentifier(identifier: string): PlanTask | undefined {
    // Try as ID
    let task = state.tasks.find((t) => t.id === identifier);
    if (task) return task;

    // Try as order number
    const order = parseInt(identifier);
    if (!isNaN(order)) {
      task = state.tasks.find((t) => t.order === order);
      if (task) return task;
    }

    // Try as partial text match
    const lower = identifier.toLowerCase();
    task = state.tasks.find((t) => t.text.toLowerCase().includes(lower));
    return task;
  }

  // ─── Config Menu ──────────────────────────────────────────────────────

  async function showConfigMenu(ctx: ExtensionContext): Promise<void> {
    const options = [
      `${config.enabled ? "✅" : "❌"} Plan tracking: ${config.enabled ? "ON" : "OFF"}`,
      `${config.autoDetect ? "✅" : "❌"} Auto-detect plans: ${config.autoDetect ? "ON" : "OFF"}`,
      `${config.showWidget ? "✅" : "❌"} Show widget: ${config.showWidget ? "ON" : "OFF"}`,
      `📐 Widget placement: ${config.widgetPlacement}`,
      `📄 Plan file prefix: ${config.planFilePrefix}`,
      `${config.trackAgents ? "✅" : "❌"} Track agents: ${config.trackAgents ? "ON" : "OFF"}`,
      `${config.trimegisto ? "✅" : "❌"} Trimegisto mode: ${config.trimegisto ? "ON" : "OFF"}`,
      `${config.showTimers ? "✅" : "❌"} Task timers: ${config.showTimers ? "ON" : "OFF"}`,
      `${config.animateWidget ? "✅" : "❌"} Animate widget: ${config.animateWidget ? "ON" : "OFF"}`,
      `${config.compactTaskLines ? "✅" : "❌"} Compact task lines: ${config.compactTaskLines ? "ON" : "OFF"}`,
      `${config.highlightCompleted ? "✅" : "❌"} Highlight completed: ${config.highlightCompleted ? "ON" : "OFF"}`,
      "───────────",
      "💾 Save plan to file",
      "📂 Load plan from file",
      "🗑️ Clear all tasks",
      "🧹 Purge plan (reset state + delete this session's plan file)",
    ];

    const choice = await ctx.ui.select("Plan Configuration:", options);

    if (!choice) return;

    if (choice.includes("Plan tracking")) {
      config.enabled = !config.enabled;
      state.enabled = config.enabled;
    } else if (choice.includes("Auto-detect")) {
      config.autoDetect = !config.autoDetect;
      state.autoDetect = config.autoDetect;
    } else if (choice.includes("Show widget")) {
      config.showWidget = !config.showWidget;
      state.showWidget = config.showWidget;
    } else if (choice.includes("Widget placement")) {
      config.widgetPlacement = config.widgetPlacement === "aboveEditor" ? "belowEditor" : "aboveEditor";
      state.widgetPlacement = config.widgetPlacement;
    } else if (choice.includes("Plan file prefix")) {
      const name = await ctx.ui.input("File prefix (files: <prefix>_<title>_<session>.md):", config.planFilePrefix);
      if (name) {
        config.planFilePrefix = slugify(name) || "plan";
        lastPlanFile = undefined; // next write lands under the new prefix
      }
    } else if (choice.includes("Track agents")) {
      config.trackAgents = !config.trackAgents;
    } else if (choice.includes("Trimegisto mode")) {
      config.trimegisto = !config.trimegisto;
      if (config.trimegisto) {
        tgConfig = readTrimegistoConfig();
        let assigned = 0;
        for (const t of state.tasks) {
          if (!t.tier) {
            t.tier = classifyTask(t.text);
            assigned++;
          }
        }
        const available = (["t1", "t2", "t3"] as Tier[]).filter((tier) => isTierAvailable(tier, tgConfig));
        const tierList = available.length > 0 ? available.join(", ") : "none (everything falls back to t0/active)";
        ctx.ui.notify(
          assigned > 0
            ? `Trimegisto mode ON — ${assigned} task(s) classified. Available tiers: ${tierList}`
            : `Trimegisto mode ON. Available tiers: ${tierList}`,
          "info"
        );
      } else {
        ctx.ui.notify("Trimegisto mode OFF", "info");
      }
    } else if (choice.includes("Task timers")) {
      config.showTimers = !config.showTimers;
    } else if (choice.includes("Animate widget")) {
      config.animateWidget = !config.animateWidget;
    } else if (choice.includes("Compact task lines")) {
      config.compactTaskLines = !config.compactTaskLines;
    } else if (choice.includes("Highlight completed")) {
      config.highlightCompleted = !config.highlightCompleted;
    } else if (choice.includes("Save plan")) {
      await writePlanFile(ctx.cwd);
      ctx.ui.notify(`Saved to ${planFileNameFor(config.planFilePrefix, state.title, sessionId)}`, "info");
    } else if (choice.includes("Load plan")) {
      const loaded = await readPlanFile(ctx.cwd);
      ctx.ui.notify(loaded ? "Plan loaded" : "No plan file found", loaded ? "info" : "warning");
    } else if (choice.includes("Clear all")) {
      const ok = await ctx.ui.confirm("Clear?", "Remove all tasks?");
      if (ok) {
        state.tasks = [];
        state.updatedAt = Date.now();
      }
    } else if (choice.includes("Purge plan")) {
      const ok = await ctx.ui.confirm(
        "Purge plan?",
        "Delete all tasks, reset state, and remove this session's plan file?"
      );
      if (ok) {
        state = {
          ...DEFAULT_STATE,
          tasks: [],
          title: "",
          titleAuto: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        try {
          await unlink(join(ctx.cwd, planFileNameFor(config.planFilePrefix, state.title, sessionId)));
          lastPlanFile = undefined;
        } catch {
          // plan file may not exist
        }
        planFilePath = "";
        ctx.ui.notify("Plan purged", "info");
      }
    }

    updateUI(ctx);
    persistState();
  }

  // ─── Reorder UI ───────────────────────────────────────────────────────

  async function showReorderUI(ctx: ExtensionContext): Promise<void> {
    if (state.tasks.length === 0) {
      ctx.ui.notify("No tasks to reorder", "info");
      return;
    }

    const choice = await ctx.ui.select(
      "Select task to move:",
      state.tasks.map((t) => `${t.order}. ${t.text}`)
    );

    if (!choice) return;

    const order = parseInt(choice);
    const task = state.tasks.find((t) => t.order === order);
    if (!task) return;

    const newOrderStr = await ctx.ui.input("Move to position:", order.toString());
    if (!newOrderStr) return;

    const newOrder = parseInt(newOrderStr);
    if (!isNaN(newOrder)) {
      moveTask(task.id, newOrder);
      ctx.ui.notify(`Moved to position ${newOrder}`, "info");
      updateUI(ctx);
      persistState();
      await writePlanFile(ctx.cwd);
    }
  }

  // ─── Show Plan Status ─────────────────────────────────────────────────

  function showPlanStatus(ctx: ExtensionContext): void {
    if (state.tasks.length === 0) {
      ctx.ui.notify("No plan tasks. Use /task add to create tasks.", "info");
      return;
    }

    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.status === "done").length;
    const inProgress = state.tasks.filter((t) => t.status === "in_progress").length;
    const pending = state.tasks.filter((t) => t.status === "pending").length;
    const blocked = state.tasks.filter((t) => t.status === "blocked").length;

    const lines = [
      `📋 ${state.title}`,
      `Progress: ${done}/${total} (${Math.round((done / total) * 100)}%)`,
      "",
      ...state.tasks
        .sort((a, b) => a.order - b.order)
        .map((t) => {
          const icon = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : t.status === "blocked" ? "🚫" : "⏳";
          const agent = t.agentName ? ` [${t.agentName}]` : "";
          const tier = config.trimegisto ? ` → ${resolveEffectiveTier(t.tier, tgConfig)}` : "";
          let timer = "";
          if (config.showTimers) {
            if (t.status === "in_progress" && t.startedAt) {
              timer = ` ⏱ ${formatElapsed(Date.now() - t.startedAt)}`;
            } else if (t.status === "done") {
              const took = completedTimerText(t.startedAt, t.completedAt);
              if (took) timer = ` (${took})`;
            }
          }
          return `${icon} ${t.order}. ${t.text}${timer}${tier}${agent}`;
        }),
    ];

    ctx.ui.notify(lines.join("\n"), "info");
  }

  // ─── Keyboard Shortcut ────────────────────────────────────────────────

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan tracking",
    handler: async (ctx) => {
      config.enabled = !config.enabled;
      state.enabled = config.enabled;
      ctx.ui.notify(`Plan ${config.enabled ? "enabled" : "disabled"}`, "info");
      updateUI(ctx);
      persistState();
    },
  });

  // ─── Event Handlers ───────────────────────────────────────────────────

  // Session start - restore state (also fires on /new, /resume, /fork, /reload)
  pi.on("session_start", async (_event, ctx) => {
    globalConfigPartial = await loadGlobalConfig();
    tgConfig = readTrimegistoConfig();
    sessionId = ctx.sessionManager.getSessionId();
    lastPlanFile = undefined;
    const entries = ctx.sessionManager.getEntries();
    // Global prefs form the base; session entries (if any) override.
    config = { ...DEFAULT_CONFIG, ...globalConfigPartial };
    const hadSessionState = entries.some((e: any) => e.type === "custom" && e.customType === "plan-state");
    if (!hadSessionState) {
      // Fresh session (new run, /new): clean plan state so parallel sessions
      // in the same directory never inherit each other's plans.
      state = { ...DEFAULT_STATE, tasks: [], createdAt: Date.now(), updatedAt: Date.now() };
    }
    restoreState(entries);
    ensureTitle(undefined, ctx);

    // Try to load this session's plan file if no tasks
    if (state.tasks.length === 0 && config.enabled) {
      await readPlanFile(ctx.cwd);
    }

    updateUI(ctx);
  });

  // Before agent start - inject plan context
  pi.on("before_agent_start", async (event, ctx) => {
    if (!config.enabled) return;

    // Inject current plan state into context
    if (state.tasks.length > 0) {
      const pending = state.tasks.filter((t) => t.status === "pending");
      const inProgress = state.tasks.filter((t) => t.status === "in_progress");
      const done = state.tasks.filter((t) => t.status === "done");

      const tierTag = (t: PlanTask) =>
        config.trimegisto ? ` (→ ${resolveEffectiveTier(t.tier, tgConfig)})` : "";

      let planContext = "[PLAN TRACKING ACTIVE]\n\n";
      planContext += `Plan: ${state.title} (file: ${planFileNameFor(config.planFilePrefix, state.title, sessionId)})\n\n`;

      // Privacy rule — plan files are runtime state and must NEVER be
      // committed or published. The session-scoped name embeds a per-session
      // id, so the rule must reference the pattern, not a fixed filename.
      planContext += "⚠️ PRIVACY: the plan file above is private runtime state — never `git add`, commit, or publish it, and never paste its contents into public outputs (issues, gists, PRs, READMEs).\n";
      planContext += `Keep it out of version control: the .gitignore pattern \`${config.planFilePrefix}_*_[0-9a-zA-Z]*.md\` covers every session-scoped plan file — the session id embedded in the name changes per session, so a fixed filename rule (e.g. \`plan.md\`) will not work. The extension maintains this .gitignore entry for you; never force-add (\`git add -f\`) or force-commit it.\n\n`;

      if (config.trimegisto) {
        const available = (["t0", "t1", "t2", "t3"] as Tier[]).filter((tier) => isTierAvailable(tier, tgConfig));
        planContext += "[TRIMEGISTO DISTRIBUTION]\n\n";
        planContext += "Each task below carries a trimegisto tier (→ tN): launch it on that tier with the trimegisto tool.\n";
        planContext += "Tier roles:\n";
        for (const tier of ["t1", "t2", "t3", "t0"] as Tier[]) {
          planContext += `- ${tierToToolValue(tier)}: ${TIER_ROLES[tier]}\n`;
        }
        planContext += `\nTiers available right now: ${available.map(tierToToolValue).join(", ")}.\n`;
        planContext += `If a task's assigned tier is NOT in that list, launch it on tier "active" instead (the → tag already shows the effective tier).\n`;
        planContext += "Batch independent tasks in ONE trimegisto call (tasks array) to run them in parallel, respecting per-tier capacity.\n";
        planContext += "When a launched task finishes, mark it done with plan_manager (action=complete).\n\n";
      }

      if (inProgress.length > 0) {
        planContext += "Currently in progress:\n";
        for (const t of inProgress) {
          const agent = t.agentName ? ` (assigned to: ${t.agentName})` : "";
          planContext += `- 🔄 ${t.order}. ${t.text}${tierTag(t)}${agent}\n`;
        }
        planContext += "\n";
      }

      if (pending.length > 0) {
        planContext += "Pending tasks:\n";
        for (const t of pending.slice(0, 10)) {
          planContext += `- ⏳ ${t.order}. ${t.text}${tierTag(t)}\n`;
        }
        if (pending.length > 10) {
          planContext += `- ... and ${pending.length - 10} more\n`;
        }
        planContext += "\n";
      }

      if (done.length > 0) {
        planContext += `Completed: ${done.length} tasks\n\n`;
      }

      planContext += "Task status is updated automatically from your tool activity and responses.\n";
      planContext += "When the plan changes, update it immediately: use plan_manager add/remove/update for new, discarded, renamed, or reprioritized tasks.\n";
      planContext += "You can also mark tasks explicitly: include [DONE:n] (n = order number above) when you finish a task, or call plan_manager with action=complete and task_id=n.\n";
      planContext += "When starting a new task, mention it clearly so the plan tracker can update.\n";

      return {
        message: {
          customType: "plan-context",
          content: planContext,
          display: false,
        },
      };
    }
  });

  // Turn end - detect plan updates
  pi.on("turn_end", async (event, ctx) => {
    if (!config.enabled) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);

    // Auto-detect new plans
    if (config.autoDetect && state.tasks.length === 0 && containsPlan(text)) {
      const tasks = extractPlanTasks(text);
      if (tasks.length >= 3) {
        ensureTitle(text, ctx); // title follows the plan's language
        state.tasks = tasks;
        if (config.trimegisto) {
          for (const t of state.tasks) {
            if (!t.tier) t.tier = classifyTask(t.text);
          }
        }
        state.updatedAt = Date.now();
        ctx.ui.notify(`Detected plan with ${tasks.length} tasks`, "info");
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }
    }

    // Gather tool evidence from this turn (tool calls + their results).
    // Used to detect which pending tasks the model is actually working on.
    const toolParts: string[] = [];
    for (const block of event.message.content) {
      if (block.type === "toolCall") {
        toolParts.push(`${block.name} ${JSON.stringify(block.arguments ?? {})}`);
      }
    }
    for (const result of event.toolResults ?? []) {
      if (result.toolName) toolParts.push(result.toolName);
      const resultText = (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join(" ");
      if (resultText) toolParts.push(resultText.slice(0, 400));
    }
    const toolCorpus = toolParts.join(" ").slice(0, 8000);

    let changed = false;
    const autoNotes: string[] = [];

    // Keep an existing plan fresh when the assistant publishes an updated or
    // remaining-task plan. The previous behavior only auto-detected the first
    // plan (when task count was zero), so long projects could drift/freeze.
    if (state.tasks.length > 0) {
      if (config.autoDetect && containsPlan(text)) {
        const refreshedTasks = extractPlanTasks(text);
        if (shouldReconcilePlan(text, refreshedTasks, state.tasks)) {
          const refresh = reconcilePlanTasks(state.tasks, refreshedTasks, {
            removeMissing: shouldRemoveMissingTasksFromPlan(text),
          });
          if (refresh.changed) {
            ensureTitle(text, ctx);
            state.tasks = refresh.tasks;
            if (config.trimegisto) {
              // Newly added tasks arrive without a tier — classify them.
              for (const t of state.tasks) {
                if (!t.tier) t.tier = classifyTask(t.text);
              }
            }
            state.updatedAt = Date.now();
            changed = true;
            const parts = [
              refresh.added > 0 ? `+${refresh.added}` : "",
              refresh.updated > 0 ? `${refresh.updated} edited` : "",
              refresh.removed > 0 ? `-${refresh.removed}` : "",
              refresh.statusChanged > 0 ? `${refresh.statusChanged} status` : "",
              refresh.reordered > 0 ? `${refresh.reordered} reordered` : "",
            ].filter(Boolean);
            autoNotes.push(`📋 plan refreshed${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`);
          }
        }
      }

      const removedIds = detectRemovedTasks(text, state.tasks);
      if (removedIds.length > 0) {
        for (const id of removedIds) {
          if (removeTask(id)) changed = true;
        }
        autoNotes.push(`🗑️ ${removedIds.length} stale task(s) removed`);
      }

      // Explicit [DONE:n] markers (from model or injected instructions)
      const explicitDone = parseDoneMarkers(text, state.tasks);

      // Natural-language + tool-evidence auto-detection
      const auto = detectAutoTransitions(text, toolCorpus, state.tasks);

      const allDone = [...new Set([...explicitDone, ...auto.completedIds])];
      if (allDone.length > 0) {
        for (const id of allDone) {
          const task = state.tasks.find((t) => t.id === id);
          if (task && task.status !== "done") {
            markTaskStatus(id, "done", ctx);
            changed = true;
          }
        }
        if (auto.completedIds.length > 0) {
          autoNotes.push(`✅ ${auto.completedIds.length} task(s) auto-completed`);
        }
      }

      if (auto.startedIds.length > 0) {
        for (const id of auto.startedIds) {
          const task = state.tasks.find((t) => t.id === id);
          if (task && task.status === "pending") {
            markTaskStatus(id, "in_progress", ctx);
            changed = true;
          }
        }
        autoNotes.push(`🔄 ${auto.startedIds.length} task(s) marked in progress`);
      }

      // Whole-work conclusion: the model signals the ENTIRE plan is done.
      // By definition nothing may remain active OR pending: active tasks are
      // completed, and pending/blocked tasks the model did not do are dropped
      // from the list (the model should have explained why in its message;
      // detectRemovedTasks above already removed any it named explicitly).
      if (detectWorkConclusion(text)) {
        const active = state.tasks.filter((t) => t.status === "in_progress");
        const dropped = state.tasks.filter((t) => t.status === "pending" || t.status === "blocked");

        for (const task of active) {
          markTaskStatus(task.id, "done", ctx);
        }
        for (const task of dropped) {
          removeTask(task.id);
        }

        if (active.length > 0 || dropped.length > 0) {
          changed = true;
          const parts: string[] = [];
          if (active.length > 0) parts.push(`${active.length} completed`);
          if (dropped.length > 0) parts.push(`${dropped.length} dropped`);
          autoNotes.push(`🎯 work concluded${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`);
        }
      } else if (detectGenericCompletion(text)) {
        // Generic (possibly singular) completion: the model finished its
        // current work without a whole-plan conclusion. Mark active tasks done
        // but leave pending tasks alone.
        const active = state.tasks.filter((t) => t.status === "in_progress");
        if (active.length > 0) {
          for (const task of active) {
            markTaskStatus(task.id, "done", ctx);
          }
          changed = true;
          autoNotes.push(`✅ ${active.length} active task(s) completed`);
        }
      }

      if (changed) {
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        if (autoNotes.length > 0) {
          ctx.ui.notify(autoNotes.join(" • "), "info");
        }
      }
    }

    // Track agent spawning
    if (config.trackAgents) {
      const agents = detectAgentTasks(text);
      for (const agent of agents) {
        trackAgentTask(agent.agentId, agent.agentName, agent.taskDescription);
      }
      if (agents.length > 0) {
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
      }
    }
  });

  // Agent end - update UI
  pi.on("agent_end", async (_event, ctx) => {
    if (!config.enabled) return;
    updateUI(ctx);
  });

  // Agent settled - the model (and any follow-ups) has fully stopped.
  // At this point nothing is actively being worked on, so any task still
  // marked in_progress is stale and must revert to pending (it wasn't
  // completed in a way we could detect, and no model is working on it now).
  pi.on("agent_settled", async (_event, ctx) => {
    if (!config.enabled) return;

    const stillActive = state.tasks.filter((t) => t.status === "in_progress");
    if (stillActive.length === 0) {
      updateUI(ctx);
      return;
    }

    for (const task of stillActive) {
      markTaskStatus(task.id, "pending", ctx);
    }
    updateUI(ctx);
    persistState();
    await writePlanFile(ctx.cwd);
    ctx.ui.notify(`⏸️ ${stillActive.length} task(s) paused (no longer active)`, "info");
  });

  // Session shutdown - stop timers (their captured ctx goes stale on
  // reload/session replacement) and save state.
  pi.on("session_shutdown", async (_event, ctx) => {
    stopAllTimers();
    if (config.enabled && state.tasks.length > 0) {
      await writePlanFile(ctx.cwd);
    }
    persistState();
  });

  // ─── Custom Tool for LLM ──────────────────────────────────────────────

  pi.registerTool({
    name: "plan_manager",
    label: "T-Plan Manager",
    description:
      "Manage the implementation plan. Use this to add, remove, update, start, block, complete, or list tasks in the project plan. " +
      "When trimegisto mode is ON, tasks are assigned a trimegisto tier (t1 complex / t2 medium / t3 simple; t0 = active fallback) " +
      "either explicitly via the tier parameter or auto-classified from the task text.",
    promptSnippet: "Manage implementation plan tasks (add, remove, complete, update, start, block, list)",
    promptGuidelines: [
      "Use plan_manager to track implementation progress when working on multi-step projects.",
      "When you complete a task, use plan_manager to mark it as done.",
      "When you discover new tasks during implementation, add them to the plan.",
      "When you discard, split, rename, or reprioritize tasks, update or remove the old tasks immediately.",
      "The plan file (plan_<title>_<session-id>.md) is PRIVATE runtime state — never commit or publish it, and never force-add it to git; keep it covered by .gitignore.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "complete", "update", "list", "start", "block", "remove"] as const),
      task_text: Type.Optional(Type.String({ description: "Task description (for add/update)" })),
      task_id: Type.Optional(Type.String({ description: "Task ID or order number (for complete/update/remove/start/block)" })),
      status: Type.Optional(StringEnum(["pending", "in_progress", "done", "blocked"] as const)),
      notes: Type.Optional(Type.String({ description: "Additional notes" })),
      tier: Type.Optional(
        StringEnum(["t0", "t1", "t2", "t3", "active"] as const, {
          description:
            "Trimegisto tier for this task: t1 = complex/deep thinking, t2 = medium/solver, t3 = simple/mechanical, t0 = active default worker. " +
            "Only meaningful when trimegisto mode is ON; auto-classified from the task text when omitted.",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "Plan tracking is disabled. Use /plan to enable." }],
          details: {},
        };
      }

      switch (params.action) {
        case "add": {
          if (!params.task_text) {
            return { content: [{ type: "text", text: "task_text is required for add action" }], details: {} };
          }
          const tier = params.tier ? toolValueToTier(params.tier) : undefined;
          ensureTitle(params.task_text, ctx);
          const task = addTask(params.task_text, "pending", undefined, tier);
          updateUI(ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          const tierNote = config.trimegisto && task.tier ? ` [${task.tier}]` : "";
          return {
            content: [{ type: "text", text: `Added task ${task.order}: ${task.text}${tierNote}` }],
            details: { task },
          };
        }

        case "complete": {
          if (!params.task_id) {
            return { content: [{ type: "text", text: "task_id is required for complete action" }], details: {} };
          }
          const task = findTaskByIdentifier(params.task_id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.task_id}` }], details: {} };
          }
          markTaskStatus(task.id, "done", ctx);
          updateUI(ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          return {
            content: [{ type: "text", text: `Completed: ${task.text}` }],
            details: { task },
          };
        }

        case "start": {
          if (!params.task_id) {
            return { content: [{ type: "text", text: "task_id is required for start action" }], details: {} };
          }
          const task = findTaskByIdentifier(params.task_id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.task_id}` }], details: {} };
          }
          markTaskStatus(task.id, "in_progress", ctx);
          updateUI(ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          return {
            content: [{ type: "text", text: `Started: ${task.text}` }],
            details: { task },
          };
        }

        case "block": {
          if (!params.task_id) {
            return { content: [{ type: "text", text: "task_id is required for block action" }], details: {} };
          }
          const task = findTaskByIdentifier(params.task_id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.task_id}` }], details: {} };
          }
          markTaskStatus(task.id, "blocked", ctx);
          if (params.notes) updateTask(task.id, { notes: params.notes });
          updateUI(ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          return {
            content: [{ type: "text", text: `Blocked: ${task.text}${params.notes ? ` — ${params.notes}` : ""}` }],
            details: { task },
          };
        }

        case "update": {
          if (!params.task_id) {
            return { content: [{ type: "text", text: "task_id is required for update action" }], details: {} };
          }
          const task = findTaskByIdentifier(params.task_id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.task_id}` }], details: {} };
          }
          const updates: Partial<PlanTask> = {};
          if (params.task_text) updates.text = params.task_text;
          if (params.status) updates.status = params.status;
          if (params.notes) updates.notes = params.notes;
          if (params.tier) {
            const tier = toolValueToTier(params.tier);
            if (tier) updates.tier = tier;
          }
          updateTask(task.id, updates);
          updateUI(ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          return {
            content: [{ type: "text", text: `Updated: ${task.text}` }],
            details: { task },
          };
        }

        case "remove": {
          if (!params.task_id) {
            return { content: [{ type: "text", text: "task_id is required for remove action" }], details: {} };
          }
          const task = findTaskByIdentifier(params.task_id);
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${params.task_id}` }], details: {} };
          }
          removeTask(task.id);
          updateUI(ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          return {
            content: [{ type: "text", text: `Removed: ${task.text}` }],
            details: {},
          };
        }

        case "list": {
          const total = state.tasks.length;
          const done = state.tasks.filter((t) => t.status === "done").length;
          const inProgress = state.tasks.filter((t) => t.status === "in_progress").length;
          const now = Date.now();

          const lines = [
            `📋 ${state.title} (${done}/${total} completed)`,
            "",
            ...state.tasks
              .sort((a, b) => a.order - b.order)
              .map((t) => {
                const icon = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : t.status === "blocked" ? "🚫" : "⏳";
                const tier = config.trimegisto ? ` → ${resolveEffectiveTier(t.tier, tgConfig)}` : "";
                let timer = "";
                if (config.showTimers) {
                  if (t.status === "in_progress" && t.startedAt) {
                    timer = ` ⏱ ${formatElapsed(now - t.startedAt)}`;
                  } else if (t.status === "done") {
                    const took = completedTimerText(t.startedAt, t.completedAt);
                    if (took) timer = ` (${took})`;
                  }
                }
                return `${icon} ${t.order}. ${t.text}${timer}${tier}`;
              }),
          ];

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { tasks: state.tasks, stats: { total, done, inProgress } },
          };
        }
      }
    },
  });
}
