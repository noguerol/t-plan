
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { PlanTask, PlanState, PlanConfig, TaskStatus, Tier } from "./types.ts";
import { DEFAULT_CONFIG, DEFAULT_STATE, SPINNER_FRAMES } from "./types.ts";
import {
  classifyTask,
  completedTimerText,
  formatElapsed,
  isTierAvailable,
  readTrimegistoConfig,
  resolveEffectiveTier,
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
  detectWorkConclusionClauses,
  detectPendingMentions,
  detectRemovedTasks,
  detectEvidenceTransitions,
  createEvidence,
  recordToolEvidence,
  resolveTaskRef,
  assignRefs,
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
import { readFile, writeFile, appendFile, access, unlink, mkdir, readdir, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function createPlanRuntime(pi: ExtensionAPI) {
  let config: PlanConfig = { ...DEFAULT_CONFIG };
  let state: PlanState = { ...DEFAULT_STATE, tasks: [] };
  let planFilePath: string = "";
  let widgetVisible = false;
  let widgetAnimationTimer: NodeJS.Timeout | undefined;
  let disposed = false; // true tras session_shutdown: el runtime viejo no debe tocar ctx stale
  let spinnerFrame = 0;
  const highlightedTasks = new Map<string, number>();
  const highlightTimers = new Set<NodeJS.Timeout>();
  let tgConfig: TrimegistoFileConfig | null = null;
  let globalConfigPartial: Partial<PlanConfig> = {};
  let sessionId: string | undefined;
  let lastPlanFile: string | undefined;

  // ── Evidencia del run en curso ────────────────────────────────────────
  // Qué ficheros/comandos tocó realmente el agente: señal determinista e
  // independiente del idioma para avanzar/completar tareas.
  let evidence = createEvidence();
  let lastStopReason: string | undefined;   // "stop" | "aborted" | "error" | ...
  let lastAssistantText = "";               // último texto del modelo (para el settle)

  const DEBUG_LOG_PATH = join(homedir(), ".pi", "agent", "t-plan", "debug.log");

  /** Los catch vacíos hacían invisibles estos fallos; con `debug` se registran. */
  function logError(scope: string, err: unknown): void {
    if (!config.debug) return;
    const line = `[${new Date().toISOString()}] ${scope}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`;
    mkdir(dirname(DEBUG_LOG_PATH), { recursive: true })
      .then(() => appendFile(DEBUG_LOG_PATH, line, "utf-8"))
      .catch(() => {});
  }

  const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "t-plan", "config.json");

  async function loadGlobalConfig(): Promise<Partial<PlanConfig>> {
    try {
      const raw = await readFile(GLOBAL_CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.config === "object" && parsed.config !== null) {
        return parsed.config as Partial<PlanConfig>;
      }
    } catch {
    }
    return {};
  }

  function saveGlobalConfig(): void {
    mkdir(dirname(GLOBAL_CONFIG_PATH), { recursive: true }).catch(() => {});
    writeFile(GLOBAL_CONFIG_PATH, JSON.stringify({ config }, null, 2), "utf-8").catch(() => {});
  }

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
        const merged = { ...DEFAULT_CONFIG, ...globalConfigPartial, ...planEntry.data.config } as PlanConfig & { planFileName?: string };
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
        // Migración: los estados persistidos antes de `ref` no lo llevan.
        state.tasks = (state.tasks ?? []).map((t) => ({ ...t, ref: typeof t.ref === "number" ? t.ref : 0 }));
        assignRefs(state.tasks);
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

  async function writePlanFile(cwd: string): Promise<void> {
    if (!config.enabled || state.tasks.length === 0) return;

    const fileName = planFileNameFor(config.planFilePrefix, state.title, sessionId);
    const filePath = join(cwd, fileName);
    if (lastPlanFile && lastPlanFile !== filePath) {
      try {
        await unlink(lastPlanFile);
      } catch {
      }
    }
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
      await ensurePlanFileGitIgnored(cwd, config.planFilePrefix);
    } catch (err) {
      logError("writePlanFile", err);
    }
  }

  async function readPlanFile(cwd: string): Promise<boolean> {
    const filePath = join(cwd, planFileNameFor(config.planFilePrefix, state.title, sessionId));

    try {
      await access(filePath);
      const content = await readFile(filePath, "utf-8");
      const tasks = extractPlanTasks(content);
      if (tasks.length > 0) {
        assignRefs(tasks);
        state.tasks = tasks;
        state.updatedAt = Date.now();
        planFilePath = filePath;
        lastPlanFile = filePath;
        return true;
      }
    } catch (err) {
      logError("readPlanFile", err);
    }
    return false;
  }

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

    async function ensurePlanFileGitIgnored(cwd: string, prefix: string): Promise<void> {
    try {
      const gitRoot = await findGitRoot(cwd);
      if (!gitRoot) return; // not inside a git repository — nothing to protect
      const gitignorePath = join(gitRoot, ".gitignore");
      let content = "";
      try {
        content = await readFile(gitignorePath, "utf-8");
      } catch {
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
    }
  }

  function startWidgetAnimation(ctx: ExtensionContext): void {
    const anyInProgress = state.tasks.some((t) => t.status === "in_progress");
    const anyActivity = anyInProgress || highlightedTasks.size > 0;
    const wantSpin = config.animateWidget;
    const wantTimer = config.showTimers && anyInProgress;
    const shouldAnimate = config.enabled && config.showWidget && anyActivity && (wantSpin || wantTimer);

    if (!shouldAnimate) {
      stopWidgetAnimation();
      return;
    }
    if (widgetAnimationTimer) return; // already running

    const interval = wantSpin ? 160 : 1000;
    widgetAnimationTimer = setInterval(() => {
      if (disposed) return; // runtime viejo tras reload: nunca tocar ctx stale
      try {
        if (wantSpin) spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
        updateUI(ctx);
      } catch {
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
      if (disposed) {
        clearInterval(timer);
        highlightTimers.delete(timer);
        return;
      }
      try {
        if (Date.now() - start >= 2400 || !highlightedTasks.has(task.id)) {
          clearInterval(timer);
          highlightTimers.delete(timer);
          highlightedTasks.delete(task.id);
          updateUI(ctx);
        }
      } catch {
        clearInterval(timer);
        highlightTimers.delete(timer);
      }
    }, 200);
    highlightTimers.add(timer);
  }

  function updateUI(ctx: ExtensionContext): void {
    if (disposed) return; // tras reload, el runtime viejo no actualiza UI
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

    if (total > 0) {
      const progress = `${done}/${total}`;
      const active = inProgress > 0 ? ` ${SPINNER_FRAMES[spinnerFrame]}${inProgress}` : "";
      ctx.ui.setStatus("t-plan", ctx.ui.theme.fg("accent", `📋 ${progress}${active}`));
    } else {
      ctx.ui.setStatus("t-plan", ctx.ui.theme.fg("muted", "📋 no plan"));
    }

    if (total > 0 && state.showWidget) {
      const now = Date.now();
      for (const [id, start] of highlightedTasks) {
        if (now - start >= 2400) highlightedTasks.delete(id);
      }

      const maxVisible = 5;

      const withTier = (t: PlanTask): PlanTask =>
        config.trimegisto ? { ...t, tier: resolveEffectiveTier(t.tier, tgConfig) } : t;

      const active = state.tasks
        .filter((t) => t.status === "in_progress" || t.status === "blocked")
        .sort((a, b) => a.order - b.order)
        .map(withTier);

      const upcoming = state.tasks
        .filter((t) => t.status === "pending")
        .sort((a, b) => a.order - b.order)
        .map(withTier);

      const completed = state.tasks
        .filter((t) => t.status === "done" && highlightedTasks.has(t.id))
        .sort((a, b) => (highlightedTasks.get(b.id) ?? 0) - (highlightedTasks.get(a.id) ?? 0))
        .slice(0, maxVisible)
        .map(withTier);

      const visibleTasks = [...active, ...upcoming, ...completed].slice(0, maxVisible);
      const remainingCount = Math.max(0, active.length + upcoming.length + completed.length - visibleTasks.length);

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

  function addTask(text: string, status: TaskStatus = "pending", order?: number, tier?: Tier): PlanTask {
    const maxRef = state.tasks.reduce((max, t) => Math.max(max, t.ref ?? 0), 0);
    const task: PlanTask = {
      id: generateId(),
      ref: maxRef + 1, // estable: nunca se renumera
      text,
      status,
      order: order ?? state.tasks.length + 1,
    };
    if (tier) {
      task.tier = tier;
    } else if (config.trimegisto) {
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

    task.everTouched = true;
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

  function touchTask(taskId: string): void {
    const task = state.tasks.find((t) => t.id === taskId);
    if (task) task.everTouched = true;
  }

  function trackAgentTask(agentId: string, agentName: string, taskText: string): void {
    const existing = state.tasks.find((t) => t.agentId === agentId);
    if (existing) {
      existing.everTouched = true;
      existing.text = taskText;
      existing.agentName = agentName;
      existing.status = "in_progress";
    } else {
      const task = addTask(taskText, "in_progress");
      task.everTouched = true;
      task.agentId = agentId;
      task.agentName = agentName;
      task.startedAt = Date.now();
    }
    state.updatedAt = Date.now();
  }

  function completeAgentTask(agentId: string): void {
    const task = state.tasks.find((t) => t.agentId === agentId);
    if (task) {
      task.everTouched = true;
      task.status = "done";
      task.completedAt = Date.now();
      state.updatedAt = Date.now();
    }
  }

  interface PlanFileCandidate {
    file: string;
    name: string;
    title: string;
    sessionId: string | undefined;
    mtimeMs: number;
    taskCount: number;
    isCurrentSession: boolean;
  }

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
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

    async function pickAndLoadPlan(ctx: ExtensionContext): Promise<void> {
    const candidates = await scanPlanFiles(ctx);
    if (candidates.length === 0) {
      ctx.ui.notify(`no plan files`, "warning");
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
        ctx.ui.notify(`no tasks in ${target.name}`, "warning");
        return;
      }
      const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (h1) {
        state.title = h1;
        state.titleAuto = false; // adopted title belongs to that project
      }
      assignRefs(tasks);
      state.tasks = tasks;
      state.updatedAt = Date.now();
      lastPlanFile = target.isCurrentSession ? target.file : undefined;
      updateUI(ctx);
      persistState();
      await writePlanFile(ctx.cwd);
      ctx.ui.notify(`loaded ${tasks.length}`, "info");
      if (target.sessionId && sessionId && target.sessionId !== sessionId.slice(0, 8)) {
        ctx.ui.notify(
          `session ${target.sessionId}: pi --session ${target.sessionId}`,
          "info"
        );
      }
    } catch (err) {
      logError("pickAndLoadPlan", err);
      ctx.ui.notify(`read fail: ${target.name}`, "error");
    }
  }

  const tPlanCommand = {
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const subcommand = args?.trim().toLowerCase();

      if (subcommand === "config") {
        await showConfigMenu(ctx);
        return;
      }

      if (subcommand === "on" || subcommand === "enable") {
        config.enabled = true;
        state.enabled = true;
        ctx.ui.notify("Plan ON", "info");
        updateUI(ctx);
        persistState();
        return;
      }

      if (subcommand === "off" || subcommand === "disable") {
        config.enabled = false;
        state.enabled = false;
        ctx.ui.notify("Plan OFF", "info");
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
          ctx.ui.notify(`new: ${title}`, "info");
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
        ctx.ui.notify("Saved", "info");
        return;
      }

      if (subcommand === "clear") {
        const ok = await ctx.ui.confirm("Clear plan?", "Remove all tasks from the current plan?");
        if (ok) {
          state.tasks = [];
          state.updatedAt = Date.now();
          ctx.ui.notify("Cleared", "info");
          updateUI(ctx);
          persistState();
        }
        return;
      }

      if (subcommand === "purge") {
        const ok = await ctx.ui.confirm(
          "Purge plan?",
          "Delete all tasks, state, and this session's plan file (no undo)."
        );
        if (ok) {
          state = {
            ...DEFAULT_STATE,
            tasks: [],
            title: DEFAULT_STATE.title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          try {
            await unlink(join(ctx.cwd, planFileNameFor(config.planFilePrefix, state.title, sessionId)));
            lastPlanFile = undefined;
          } catch {
          }
          planFilePath = "";
          ctx.ui.notify("purged", "info");
          updateUI(ctx);
          persistState();
        }
        return;
      }

      config.enabled = !config.enabled;
      state.enabled = config.enabled;
      ctx.ui.notify(`Plan ${config.enabled ? "ON" : "OFF"}`, "info");
      updateUI(ctx);
      persistState();
    },
  };

  const taskCommand = {
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      if (!config.enabled) {
        ctx.ui.notify("plan off", "warning");
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
        ctx.ui.notify("Added", "info");
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      if (action === "done" || action === "complete") {
        const identifier = parts[1];
        if (!identifier) {
          const pending = state.tasks.filter((t) => t.status !== "done");
          if (pending.length === 0) {
            ctx.ui.notify("Nothing pending", "info");
            return;
          }
          const choice = await ctx.ui.select(
            "Mark as done:",
            pending.map((t) => `#${t.ref}. ${t.text}`)
          );
          if (choice) {
            const task = resolveTaskRef(state.tasks, choice.replace(/^[^\d]*/, ""));
            if (task) {
              markTaskStatus(task.id, "done", ctx);
              ctx.ui.notify(`✓ #${task.ref} ${task.text}`, "info");
            }
          }
        } else {
          const task = findTaskByIdentifier(identifier);
          if (task) {
            markTaskStatus(task.id, "done", ctx);
            ctx.ui.notify(`✓ ${task.text}`, "info");
          } else {
            ctx.ui.notify(`Not found: ${identifier}`, "error");
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
            state.tasks.map((t) => `#${t.ref}. ${t.text}`)
          );
          if (choice) {
            const task = resolveTaskRef(state.tasks, choice.replace(/^[^\d]*/, ""));
            if (task) {
              removeTask(task.id);
              ctx.ui.notify("Removed", "info");
            }
          }
        } else {
          const task = findTaskByIdentifier(identifier);
          if (task) {
            removeTask(task.id);
            ctx.ui.notify("Removed", "info");
          } else {
            ctx.ui.notify(`Not found: ${identifier}`, "error");
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
            state.tasks.map((t) => `#${t.ref}. ${t.text}`)
          );
          if (choice) {
            const t = resolveTaskRef(state.tasks, choice.replace(/^[^\d]*/, ""));
            if (t) {
              const newText = await ctx.ui.input("New text:", t.text);
              if (newText) {
                updateTask(t.id, { text: newText });
                ctx.ui.notify("Updated", "info");
              }
            }
          }
        } else {
          const newText = await ctx.ui.input("New text:", task.text);
          if (newText) {
            updateTask(task.id, { text: newText });
            ctx.ui.notify("Updated", "info");
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
            ctx.ui.notify(`→ #${newOrder}`, "info");
          }
        } else {
          const input = await ctx.ui.input("New position:", task.order.toString());
          if (input) {
            const newOrder = parseInt(input);
            if (!isNaN(newOrder)) {
              moveTask(task.id, newOrder);
              ctx.ui.notify(`→ #${newOrder}`, "info");
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
              pending.map((t) => `#${t.ref}. ${t.text}`)
            );
            if (choice) {
              const t = resolveTaskRef(state.tasks, choice.replace(/^[^\d]*/, ""));
              if (t) {
                markTaskStatus(t.id, "in_progress", ctx);
                ctx.ui.notify(`▶ ${t.text}`, "info");
              }
            }
          }
        } else {
          markTaskStatus(task.id, "in_progress", ctx);
          ctx.ui.notify(`▶ ${task.text}`, "info");
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
          ctx.ui.notify(`✗ ${task.text}`, "info");
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
              ctx.ui.notify("Invalid tier", "error");
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
            ctx.ui.notify(`#${task.ref}→${tier}`, "info");
          }
        } else {
          const choice = await ctx.ui.select(
            "Set tier for task:",
            state.tasks.map((t) => `#${t.ref}. ${t.text}`)
          );
          if (choice) {
            const t = resolveTaskRef(state.tasks, choice.replace(/^[^\d]*/, ""));
            if (t) {
              const tier = await pickTier();
              if (tier) {
                updateTask(t.id, { tier });
                ctx.ui.notify(`#${t.ref}→${tier}`, "info");
              }
            }
          }
        }
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }

      ctx.ui.notify(
        `/task <action> [args]
  add [text]   add [t0-t3]
  done|remove|edit|move|start|block|tier [id]…`,
        "info"
      );
    },
  };

  function findTaskByIdentifier(identifier: unknown): PlanTask | undefined {
    const task = resolveTaskRef(state.tasks, identifier);
    if (task) task.everTouched = true;
    return task;
  }

  /** Lista compacta con refs: se devuelve al modelo cuando no resuelve un task_id. */
  function taskRefList(): string {
    return state.tasks
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => `${t.status === "done" ? "x" : t.status === "in_progress" ? ">" : t.status === "blocked" ? "!" : " "} #${t.ref} ${t.text}`)
      .join("\n");
  }

  /**
   * Resuelve task_id aceptando uno o varios refs: "3", "2,3", "2-4", "2 3", "all",
   * o texto libre (con fallback difuso). Antes sólo existía la coincidencia literal,
   * así que un task_id aproximado devolvía "Task not found" y la tarea quedaba pendiente.
   */
  function resolveTaskIds(identifier: unknown): PlanTask[] {
    const raw = (typeof identifier === "string" ? identifier : String(identifier ?? "")).trim();
    if (!raw) return [];

    if (/^(?:all|todo|todos|todas|everything|\*)$/i.test(raw)) {
      return state.tasks
        .filter((t) => t.status !== "done")
        .map((t) => {
          t.everTouched = true;
          return t;
        });
    }

    const numericList = /^#?\d+(?:[\s,;/|]+#?\d+)+$/.test(raw);
    const chunks = raw
      .split(numericList ? /[\s,;/|]+/ : /[,;/|]+|\s+(?:y|and)\s+/)
      .map((c) => c.trim())
      .filter(Boolean);

    const out: PlanTask[] = [];
    const push = (task: PlanTask | undefined): void => {
      if (task && !out.some((x) => x.id === task.id)) out.push(task);
    };

    for (const chunk of chunks) {
      const range = chunk.match(/^#?(\d+)\s*[-\u2013\u2014]\s*#?(\d+)$/);
      if (range) {
        const from = Math.min(+range[1], +range[2]);
        const to = Math.max(+range[1], +range[2]);
        for (let n = from; n <= to && n - from < 50; n++) push(findTaskByIdentifier(String(n)));
        continue;
      }
      push(findTaskByIdentifier(chunk));
    }
    return out;
  }

  async function showConfigMenu(ctx: ExtensionContext): Promise<void> {
    const options = [
      `${config.enabled ? "✅" : "❌"} Track: ${config.enabled ? "ON" : "OFF"}`,
      `${config.autoDetect ? "✅" : "❌"} Auto-detect: ${config.autoDetect ? "ON" : "OFF"}`,
      `${config.showWidget ? "✅" : "❌"} Widget: ${config.showWidget ? "ON" : "OFF"}`,
      `📐 Placement: ${config.widgetPlacement}`,
      `📄 Prefix: ${config.planFilePrefix}`,
      `${config.trackAgents ? "✅" : "❌"} Agents: ${config.trackAgents ? "ON" : "OFF"}`,
      `${config.trimegisto ? "✅" : "❌"} TG: ${config.trimegisto ? "ON" : "OFF"}`,
      `${config.showTimers ? "✅" : "❌"} Timers: ${config.showTimers ? "ON" : "OFF"}`,
      `${config.toolEvidence ? "✅" : "❌"} Tool evidence: ${config.toolEvidence ? "ON" : "OFF"}`,
      `${config.debug ? "✅" : "❌"} Debug log: ${config.debug ? "ON" : "OFF"}`,
      `${config.animateWidget ? "✅" : "❌"} Animate: ${config.animateWidget ? "ON" : "OFF"}`,
      `${config.compactTaskLines ? "✅" : "❌"} Compact: ${config.compactTaskLines ? "ON" : "OFF"}`,
      `${config.highlightCompleted ? "✅" : "❌"} Highlight: ${config.highlightCompleted ? "ON" : "OFF"}`,
      "──",
      "💾 Save",
      "📂 Load",
      "🗑️ Clear",
      "🧹 Purge",
    ];

    const choice = await ctx.ui.select("Plan Configuration:", options);

    if (!choice) return;

    if (choice.includes("Track")) {
      config.enabled = !config.enabled;
      state.enabled = config.enabled;
    } else if (choice.includes("Auto-detect")) {
      config.autoDetect = !config.autoDetect;
      state.autoDetect = config.autoDetect;
    } else if (choice.includes("Widget:")) {
      config.showWidget = !config.showWidget;
      state.showWidget = config.showWidget;
    } else if (choice.includes("Placement")) {
      config.widgetPlacement = config.widgetPlacement === "aboveEditor" ? "belowEditor" : "aboveEditor";
      state.widgetPlacement = config.widgetPlacement;
    } else if (choice.includes("Prefix:")) {
      const name = await ctx.ui.input("File prefix (<prefix>_<title>_<session>.md):", config.planFilePrefix);
      if (name) {
        config.planFilePrefix = slugify(name) || "plan";
        lastPlanFile = undefined;
      }
    } else if (choice.includes("Agents:")) {
      config.trackAgents = !config.trackAgents;
    } else if (choice.includes("TG")) {
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
        const tierList = available.length > 0 ? available.join(", ") : "none (fallback active)";
        ctx.ui.notify(assigned > 0 ? `TG ON: ${assigned} classified. ${tierList}` : `TG ON. ${tierList}`, "info");
      } else {
        ctx.ui.notify("TG OFF", "info");
      }
    } else if (choice.includes("Timers")) {
      config.showTimers = !config.showTimers;
    } else if (choice.includes("Tool evidence")) {
      config.toolEvidence = !config.toolEvidence;
      ctx.ui.notify(
        config.toolEvidence
          ? "Tool evidence ON: touched files/commands complete tasks"
          : "Tool evidence OFF: only text/markers drive status",
        "info"
      );
    } else if (choice.includes("Debug log")) {
      config.debug = !config.debug;
      ctx.ui.notify(config.debug ? `Debug log ON: ${DEBUG_LOG_PATH}` : "Debug log OFF", "info");
    } else if (choice.includes("Animate")) {
      config.animateWidget = !config.animateWidget;
    } else if (choice.includes("Compact")) {
      config.compactTaskLines = !config.compactTaskLines;
    } else if (choice.includes("Highlight")) {
      config.highlightCompleted = !config.highlightCompleted;
    } else if (choice.startsWith("💾")) {
      await writePlanFile(ctx.cwd);
      ctx.ui.notify("Saved", "info");
    } else if (choice.startsWith("📂")) {
      const loaded = await readPlanFile(ctx.cwd);
      ctx.ui.notify(loaded ? "Loaded" : "No plan file", loaded ? "info" : "warning");
    } else if (choice.startsWith("🗑️")) {
      const ok = await ctx.ui.confirm("Clear?", "Remove all tasks?");
      if (ok) {
        state.tasks = [];
        state.updatedAt = Date.now();
      }
    } else if (choice.startsWith("🧹")) {
      const ok = await ctx.ui.confirm(
        "Purge plan?",
        "Delete all tasks, state, and this session's plan file?"
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
        }
        planFilePath = "";
        ctx.ui.notify("purged", "info");
      }
    }

    updateUI(ctx);
    persistState();
  }

  async function showReorderUI(ctx: ExtensionContext): Promise<void> {
    if (state.tasks.length === 0) {
      ctx.ui.notify("Nothing to reorder", "info");
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
      ctx.ui.notify(`→ #${newOrder}`, "info");
      updateUI(ctx);
      persistState();
      await writePlanFile(ctx.cwd);
    }
  }

  function showPlanStatus(ctx: ExtensionContext): void {
    if (state.tasks.length === 0) {
      ctx.ui.notify("Empty plan", "info");
      return;
    }

    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.status === "done").length;
    const inProgress = state.tasks.filter((t) => t.status === "in_progress").length;
    const pending = state.tasks.filter((t) => t.status === "pending").length;
    const blocked = state.tasks.filter((t) => t.status === "blocked").length;

    const lines = [
      `${state.title}`,
      `${done}/${total} (${Math.round((done / total) * 100)}%)`,
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
          return `${icon} #${t.ref}. ${t.text}${timer}${tier}${agent}`;
        }),
    ];

    ctx.ui.notify(lines.join("\n"), "info");
  }

  const shortcut = {
    handler: async (ctx: ExtensionContext) => {
      config.enabled = !config.enabled;
      state.enabled = config.enabled;
      ctx.ui.notify(`Plan ${config.enabled ? "ON" : "OFF"}`, "info");
      updateUI(ctx);
      persistState();
    },
  };

  const onSessionStart = async (_event: unknown, ctx: ExtensionContext) => {
    try {
    globalConfigPartial = await loadGlobalConfig();
    tgConfig = readTrimegistoConfig();
    sessionId = ctx.sessionManager.getSessionId();
    lastPlanFile = undefined;
    const entries = ctx.sessionManager.getEntries();
    config = { ...DEFAULT_CONFIG, ...globalConfigPartial };
    const hadSessionState = entries.some((e: any) => e.type === "custom" && e.customType === "plan-state");
    if (!hadSessionState) {
      state = { ...DEFAULT_STATE, tasks: [], createdAt: Date.now(), updatedAt: Date.now() };
    }
    restoreState(entries);
    ensureTitle(undefined, ctx);

    if (state.tasks.length === 0 && config.enabled) {
      await readPlanFile(ctx.cwd);
    }

    updateUI(ctx);
    } catch (err) { logError("session_start", err); /* stale ctx/reload */ }
  };

  const onBeforeAgentStart = async (event: any, ctx: ExtensionContext) => {
    try {
    // Nueva petición del usuario => nueva evidencia; también se limpia el stopReason
    // del run anterior para que agent_settled no decida con datos viejos.
    evidence = createEvidence();
    lastStopReason = undefined;
    lastAssistantText = "";

    if (!config.enabled) return;

    if (state.tasks.length > 0) {
      const pending = state.tasks.filter((t) => t.status === "pending");
      const inProgress = state.tasks.filter((t) => t.status === "in_progress");
      const blocked = state.tasks.filter((t) => t.status === "blocked");
      const done = state.tasks.filter((t) => t.status === "done");

      const tierTag = (t: PlanTask) =>
        config.trimegisto ? ` (→ ${resolveEffectiveTier(t.tier, tgConfig)})` : "";

      const planFile = planFileNameFor(config.planFilePrefix, state.title, sessionId);
      let planContext = `[PLAN]\n${state.title} (file: ${planFile})\n`;
      planContext += `Private: never git add/commit/publish plan files; gitignore ${config.planFilePrefix}_*_[0-9a-zA-Z]*.md; no force-add.\n`;
      planContext += `Refs (#n) are stable handles: use them in task_id and [DONE:#n].\n\n`;

      if (config.trimegisto) {
        const available = (["t0", "t1", "t2", "t3"] as Tier[]).filter((tier) => isTierAvailable(tier, tgConfig));
        planContext += "[TG]\n";
        planContext += "Use task →tier with trimegisto; unavailable => active. Batch independent tasks. Finish => plan_manager complete.\n";
        planContext += "tiers: active=t0 default; t1=complex/planning; t2=medium/debug/review; t3=simple/mechanical\n";
        planContext += `available: ${available.map(tierToToolValue).join(", ")}\n\n`;
      }

      if (inProgress.length > 0) {
        planContext += "Doing:\n";
        for (const t of inProgress) {
          const agent = t.agentName ? ` @${t.agentName}` : "";
          planContext += `- 🔄 #${t.ref}. ${t.text}${tierTag(t)}${agent}\n`;
        }
        planContext += "\n";
      }

      // Todo el plan visible: antes se recortaba a 10 pendientes y la tarea 11+
      // era imposible de completar (el modelo no sabía que existía).
      const PENDING_CAP = 40;
      if (pending.length > 0) {
        planContext += "Todo:\n";
        for (const t of pending.slice(0, PENDING_CAP)) {
          planContext += `- ⏳ #${t.ref}. ${t.text}${tierTag(t)}\n`;
        }
        if (pending.length > PENDING_CAP) planContext += `- ... +${pending.length - PENDING_CAP} more (plan_manager list)\n`;
        planContext += "\n";
      }

      if (blocked.length > 0) {
        planContext += `Blocked: ${blocked.map((t) => `#${t.ref}`).join(", ")}\n\n`;
      }

      if (done.length > 0) {
        const refs = done.slice(-12).map((t) => `#${t.ref}`).join(", ");
        planContext += `Done (${done.length}): ${refs}${done.length > 12 ? ", ..." : ""}\n\n`;
      }

      planContext += "Rules: before ending the turn call plan_manager complete task_id=<ref> for EVERY finished task (accepts \"2,3\" and text). Plan changed? add/remove/update. Starting? plan_manager start or name the task. Auto-tracking also uses the files/commands you touch.\n";

      return {
        message: {
          customType: "plan-context",
          content: planContext,
          display: false,
        },
      };
    }
    } catch (err) { logError("before_agent_start", err); /* stale ctx/reload */ }
  };

  /**
   * Evidencia determinista: args reales de cada herramienta (rutas, comandos).
   * `tool_result` trae `input` tipado, sin los recortes del texto del resultado.
   */
  const onToolResult = async (event: any, _ctx: ExtensionContext) => {
    try {
      if (!config.enabled || !config.toolEvidence) return;
      if (!event?.toolName || event.toolName === "plan_manager") return;
      recordToolEvidence(evidence, event.toolName, event.input, event.isError === true);
    } catch (err) { logError("tool_result", err); }
  };

  const onTurnEnd = async (event: any, ctx: ExtensionContext) => {
    try {
    if (!config.enabled) return;
    if (!isAssistantMessage(event.message)) return;

    const message = event.message;
    if (typeof message.stopReason === "string") lastStopReason = message.stopReason;

    const text = getTextContent(message);
    if (text.trim()) lastAssistantText = text;

    if (config.autoDetect && state.tasks.length === 0 && containsPlan(text)) {
      const tasks = extractPlanTasks(text);
      if (tasks.length >= 3) {
        ensureTitle(text, ctx); // title follows the plan's language
        assignRefs(tasks);
        // everTouched NO se marca en bloque: sólo cuenta la evidencia por tarea,
        // si no la rama "descartar no tocadas" de la conclusión queda muerta.
        state.tasks = tasks;
        if (config.trimegisto) {
          for (const t of state.tasks) {
            if (!t.tier) t.tier = classifyTask(t.text);
          }
        }
        state.updatedAt = Date.now();
        persistState();
        await writePlanFile(ctx.cwd);
        updateUI(ctx);
        ctx.ui.notify(`+${tasks.length} tasks`, "info");
        return;
      }
    }

    const toolParts: string[] = [];
    for (const block of message.content) {
      if (block.type === "toolCall") {
        toolParts.push(`${block.name} ${JSON.stringify(block.arguments ?? {})}`);
      }
    }
    for (const result of event.toolResults ?? []) {
      if (result.toolName) toolParts.push(result.toolName);
      const resultText = ((result.content ?? []) as Array<{ type: string; text?: string }>)
        .filter((c: { type: string; text?: string }) => c.type === "text")
        .map((c: { type: string; text?: string }) => c.text ?? "")
        .join(" ");
      if (resultText) toolParts.push(resultText.slice(0, 400));
    }
    const toolCorpus = toolParts.join(" ").slice(0, 8000);

    let changed = false;
    const autoNotes: string[] = [];

    if (state.tasks.length > 0) {
      // Snapshot con los refs vigentes AL INICIO del turno: el modelo trabaja con la
      // numeración que recibió en before_agent_start, y las reconciliaciones/borrados
      // renumeran `order`. Resolver contra el snapshot evita marcar la tarea equivocada.
      const snapshot = state.tasks.map((t) => ({ ...t }));
      const explicitDone = parseDoneMarkers(text, snapshot);
      for (const id of explicitDone) touchTask(id);

      if (config.autoDetect && containsPlan(text)) {
        const refreshedTasks = extractPlanTasks(text);
        if (shouldReconcilePlan(text, refreshedTasks, state.tasks)) {
          const refresh = reconcilePlanTasks(state.tasks, refreshedTasks, {
            removeMissing: shouldRemoveMissingTasksFromPlan(text),
          });
          if (refresh.changed) {
            ensureTitle(text, ctx);
            state.tasks = refresh.tasks;
            assignRefs(state.tasks);
            if (config.trimegisto) {
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
            autoNotes.push(`↻ refreshed${parts.length ? ` ${parts.join(",")}` : ""}`);
          }
        }
      }

      // Nunca borrar una tarea que el modelo acaba de dar por hecha en el mismo texto.
      const removedIds = detectRemovedTasks(text, state.tasks, explicitDone);
      if (removedIds.length > 0) {
        for (const id of removedIds) {
          touchTask(id);
          if (removeTask(id)) changed = true;
        }
        autoNotes.push(`-${removedIds.length} stale`);
      }

      const auto = detectAutoTransitions(text, toolCorpus, state.tasks);
      for (const id of auto.completedIds) touchTask(id);
      for (const id of auto.startedIds) touchTask(id);

      // Lo que el modelo declara explícitamente pendiente no se completa por evidencia.
      const mentionedPending = detectPendingMentions(text, state.tasks);
      const byEvidence = config.toolEvidence
        ? detectEvidenceTransitions(state.tasks, evidence, {
            complete: false,
            excludeIds: mentionedPending,
          })
        : { completedIds: [] as string[], startedIds: [] as string[] };
      for (const id of byEvidence.startedIds) touchTask(id);

      const allDone = [
        ...new Set([
          ...explicitDone.filter((id) => state.tasks.some((t) => t.id === id)),
          ...auto.completedIds,
        ]),
      ];
      if (allDone.length > 0) {
        for (const id of allDone) {
          const task = state.tasks.find((t) => t.id === id);
          if (task && task.status !== "done") {
            markTaskStatus(id, "done", ctx);
            changed = true;
          }
        }
        autoNotes.push(`+${allDone.length} done`);
      }

      const allStarted = [...new Set([...auto.startedIds, ...byEvidence.startedIds])];
      if (allStarted.length > 0) {
        let started = 0;
        for (const id of allStarted) {
          const task = state.tasks.find((t) => t.id === id);
          if (task && task.status === "pending" && !mentionedPending.includes(id)) {
            markTaskStatus(id, "in_progress", ctx);
            started++;
            changed = true;
          }
        }
        if (started > 0) autoNotes.push(`${started} in-progress`);
      }

      // Conclusión por cláusulas: un cierre real mezcla lo terminado con lo que queda
      // ("Listo, commit y push hechos. Queda pendiente el despliegue.") y el veto global
      // anterior anulaba toda la detección.
      const clauses = detectWorkConclusionClauses(text);
      if (clauses.conclusion) {
        const active = state.tasks.filter((t) => t.status === "in_progress");
        const leftover = state.tasks.filter((t) => t.status === "pending" || t.status === "blocked");
        const withEvidence = new Set(
          config.toolEvidence
            ? detectEvidenceTransitions(leftover, evidence, {
                complete: true,
                excludeIds: mentionedPending,
              }).completedIds
            : []
        );
        // "Tocada" = referenced by a marker, by tool evidence, by fuzzy completion or
        // edited by hand. Las que nadie tocó se descartan (intención original); las que
        // siguen declaradas pendientes se conservan como pendientes.
        const keep = leftover.filter(
          (t) => (t.everTouched || withEvidence.has(t.id)) && !mentionedPending.includes(t.id)
        );
        const hold = leftover.filter((t) => mentionedPending.includes(t.id));
        const drop = leftover.filter(
          (t) => !t.everTouched && !withEvidence.has(t.id) && !mentionedPending.includes(t.id)
        );

        for (const task of active) markTaskStatus(task.id, "done", ctx);
        for (const task of keep) {
          touchTask(task.id);
          markTaskStatus(task.id, "done", ctx);
        }
        for (const task of hold) touchTask(task.id);
        for (const task of drop) removeTask(task.id);

        if (active.length > 0 || keep.length > 0 || drop.length > 0) {
          changed = true;
          const parts: string[] = [];
          if (active.length > 0) parts.push(`${active.length} completed`);
          if (keep.length > 0) parts.push(`${keep.length} finalized`);
          if (drop.length > 0) parts.push(`${drop.length} dropped`);
          autoNotes.push(`done: ${parts.join(",")}`);
        }
      } else if (detectGenericCompletion(text)) {
        const active = state.tasks.filter((t) => t.status === "in_progress");
        if (active.length > 0) {
          for (const task of active) {
            markTaskStatus(task.id, "done", ctx);
          }
          changed = true;
          autoNotes.push(`${active.length} done`);
        }
      }

      if (changed) {
        // Persistir ANTES de pintar: si updateUI lanza (ctx stale tras reload) el estado
        // ya está guardado en la sesión y en el fichero de plan.
        persistState();
        await writePlanFile(ctx.cwd);
        updateUI(ctx);
        if (autoNotes.length > 0) {
          ctx.ui.notify(autoNotes.join(" • "), "info");
        }
      }
    }

    if (config.trackAgents) {
      const agents = detectAgentTasks(text);
      for (const agent of agents) {
        trackAgentTask(agent.agentId, agent.agentName, agent.taskDescription);
      }
      if (agents.length > 0) {
        persistState();
        await writePlanFile(ctx.cwd);
        updateUI(ctx);
      }
    }
    } catch (err) { logError("turn_end", err); /* stale ctx/reload */ }
  };

  const onAgentEnd = async (_event: unknown, ctx: ExtensionContext) => {
    try {
    if (!config.enabled) return;
    updateUI(ctx);
    } catch (err) { logError("agent_end", err); }
  };

  const onAgentSettled = async (_event: unknown, ctx: ExtensionContext) => {
    try {
    if (!config.enabled) return;

    // agent_settled se emite en un `finally` tras CUALQUIER run (éxito, aborto o error).
    // Degradar in_progress → pending incondicionalmente devolvía a pendientes tareas
    // que el agente acababa de completar en cada ejecución normal.
    const interrupted = lastStopReason === "aborted" || lastStopReason === "error";
    const mentionedPending = detectPendingMentions(lastAssistantText, state.tasks);
    let changed = false;
    const notes: string[] = [];

    // Run normal: la evidencia de herramientas (ficheros/comandos tocados) cierra las
    // tareas que el modelo no llegó a marcar. Varias a la vez, sin depender del idioma.
    if (!interrupted && config.toolEvidence) {
      const byEvidence = detectEvidenceTransitions(state.tasks, evidence, {
        complete: true,
        excludeIds: mentionedPending,
      });
      let completed = 0;
      for (const id of byEvidence.completedIds) {
        const task = state.tasks.find((t) => t.id === id);
        if (!task || task.status === "done") continue;
        touchTask(id);
        markTaskStatus(id, "done", ctx);
        completed++;
      }
      if (completed > 0) {
        changed = true;
        notes.push(`✓ ${completed} by tool evidence`);
      }
    }

    // Sólo una interrupción real justifica pausar lo que estaba en curso.
    if (interrupted) {
      const stillActive = state.tasks.filter((t) => t.status === "in_progress");
      for (const task of stillActive) {
        markTaskStatus(task.id, "pending", ctx);
      }
      if (stillActive.length > 0) {
        changed = true;
        notes.push(`⏸ ${stillActive.length} paused`);
      }
    }

    if (changed) {
      persistState();
      await writePlanFile(ctx.cwd);
    }
    updateUI(ctx);
    if (notes.length > 0) ctx.ui.notify(notes.join(" • "), "info");
    lastStopReason = undefined;
    } catch (err) { logError("agent_settled", err); }
  };

  const onSessionShutdown = async (_event: unknown, ctx: ExtensionContext) => {
    // Síncrono y primero: el runtime viejo queda inerte antes de que pi lo
    // invalide; ningún timer ni continuación tocará un ctx stale tras reload.
    disposed = true;
    stopAllTimers();
    try {
      if (config.enabled && state.tasks.length > 0) {
        await writePlanFile(ctx.cwd);
      }
      persistState();
    } catch (err) { logError("session_shutdown", err); /* stale ctx/reload */ }
  };

  const planManagerTool = {
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<any>> {
      if (!config.enabled) {
        return {
          content: [{ type: "text", text: "plan off" }],
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
            content: [{ type: "text", text: `Added task #${task.ref}: ${task.text}${tierNote}` }],
            details: { task },
          };
        }

        case "complete": {
          if (params.task_id === undefined || params.task_id === null || String(params.task_id).trim() === "") {
            return {
              content: [{ type: "text", text: `task_id is required for complete action. Refs:\n${taskRefList()}` }],
              details: {},
            };
          }
          const targets = resolveTaskIds(params.task_id);
          if (targets.length === 0) {
            return {
              content: [{ type: "text", text: `Task not found: ${String(params.task_id)}\nRefs:\n${taskRefList()}` }],
              details: { notFound: String(params.task_id) },
            };
          }
          for (const target of targets) markTaskStatus(target.id, "done", ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          updateUI(ctx);
          return {
            content: [{ type: "text", text: targets.map((t) => `✓ #${t.ref} ${t.text}`).join("\n") }],
            details: { task: targets[0], tasks: targets },
          };
        }

        case "start": {
          if (params.task_id === undefined || params.task_id === null || String(params.task_id).trim() === "") {
            return { content: [{ type: "text", text: `task_id is required for start action. Refs:\n${taskRefList()}` }], details: {} };
          }
          const task = resolveTaskIds(params.task_id)[0];
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${String(params.task_id)}\nRefs:\n${taskRefList()}` }], details: { notFound: String(params.task_id) } };
          }
          markTaskStatus(task.id, "in_progress", ctx);
          persistState();
          await writePlanFile(ctx.cwd);
          updateUI(ctx);
          return {
            content: [{ type: "text", text: `▶ #${task.ref} ${task.text}` }],
            details: { task },
          };
        }

        case "block": {
          if (params.task_id === undefined || params.task_id === null || String(params.task_id).trim() === "") {
            return { content: [{ type: "text", text: `task_id is required for block action. Refs:\n${taskRefList()}` }], details: {} };
          }
          const task = resolveTaskIds(params.task_id)[0];
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${String(params.task_id)}\nRefs:\n${taskRefList()}` }], details: { notFound: String(params.task_id) } };
          }
          markTaskStatus(task.id, "blocked", ctx);
          if (params.notes) updateTask(task.id, { notes: params.notes });
          persistState();
          await writePlanFile(ctx.cwd);
          updateUI(ctx);
          return {
            content: [{ type: "text", text: `Blocked: #${task.ref} ${task.text}${params.notes ? ` — ${params.notes}` : ""}` }],
            details: { task },
          };
        }

        case "update": {
          if (params.task_id === undefined || params.task_id === null || String(params.task_id).trim() === "") {
            return { content: [{ type: "text", text: `task_id is required for update action. Refs:\n${taskRefList()}` }], details: {} };
          }
          const task = resolveTaskIds(params.task_id)[0];
          if (!task) {
            return { content: [{ type: "text", text: `Task not found: ${String(params.task_id)}\nRefs:\n${taskRefList()}` }], details: { notFound: String(params.task_id) } };
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
          task.everTouched = true;
          persistState();
          await writePlanFile(ctx.cwd);
          updateUI(ctx);
          return {
            content: [{ type: "text", text: `Updated: #${task.ref} ${task.text}` }],
            details: { task },
          };
        }

        case "remove": {
          if (params.task_id === undefined || params.task_id === null || String(params.task_id).trim() === "") {
            return { content: [{ type: "text", text: `task_id is required for remove action. Refs:\n${taskRefList()}` }], details: {} };
          }
          const targets = resolveTaskIds(params.task_id);
          if (targets.length === 0) {
            return { content: [{ type: "text", text: `Task not found: ${String(params.task_id)}\nRefs:\n${taskRefList()}` }], details: { notFound: String(params.task_id) } };
          }
          for (const target of targets) removeTask(target.id);
          persistState();
          await writePlanFile(ctx.cwd);
          updateUI(ctx);
          return {
            content: [{ type: "text", text: targets.map((t) => `Removed: #${t.ref} ${t.text}`).join("\n") }],
            details: { removed: targets.length },
          };
        }

        case "list": {
          const total = state.tasks.length;
          const done = state.tasks.filter((t) => t.status === "done").length;
          const inProgress = state.tasks.filter((t) => t.status === "in_progress").length;
          const now = Date.now();

          const lines = [
            `${state.title} (${done}/${total} done)`,
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
                return `${icon} #${t.ref}. ${t.text}${timer}${tier}`;
              }),
          ];

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { tasks: state.tasks, stats: { total, done, inProgress } },
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${String(params?.action)}. Use add|complete|update|list|start|block|remove. Refs:\n${taskRefList()}` }],
            details: {},
          };
      }
    },
  };

  return {
    tPlanCommand,
    taskCommand,
    shortcut,
    onSessionStart,
    onBeforeAgentStart,
    onToolResult,
    onTurnEnd,
    onAgentEnd,
    onAgentSettled,
    onSessionShutdown,
    planManagerTool,
  };
}
