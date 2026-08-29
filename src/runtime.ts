
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
  let spinnerFrame = 0;
  const highlightedTasks = new Map<string, number>();
  const highlightTimers = new Set<NodeJS.Timeout>();
  let tgConfig: TrimegistoFileConfig | null = null;
  let globalConfigPartial: Partial<PlanConfig> = {};
  let sessionId: string | undefined;
  let lastPlanFile: string | undefined;

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
    const task: PlanTask = {
      id: generateId(),
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

  function trackAgentTask(agentId: string, agentName: string, taskText: string): void {
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
            pending.map((t) => `${t.order}. ${t.text}`)
          );
          if (choice) {
            const order = parseInt(choice);
            const task = state.tasks.find((t) => t.order === order);
            if (task) {
              markTaskStatus(task.id, "done", ctx);
              ctx.ui.notify(`✓ ${task.text}`, "info");
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
            state.tasks.map((t) => `${t.order}. ${t.text}`)
          );
          if (choice) {
            const order = parseInt(choice);
            const task = state.tasks.find((t) => t.order === order);
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
            state.tasks.map((t) => `${t.order}. ${t.text}`)
          );
          if (choice) {
            const order = parseInt(choice);
            const t = state.tasks.find((t) => t.order === order);
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
              pending.map((t) => `${t.order}. ${t.text}`)
            );
            if (choice) {
              const order = parseInt(choice);
              const t = state.tasks.find((t) => t.order === order);
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
            ctx.ui.notify(`T${task.order}→${tier}`, "info");
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
                ctx.ui.notify(`T${t.order}→${tier}`, "info");
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

  function findTaskByIdentifier(identifier: string): PlanTask | undefined {
    let task = state.tasks.find((t) => t.id === identifier);
    if (task) return task;

    const order = parseInt(identifier);
    if (!isNaN(order)) {
      task = state.tasks.find((t) => t.order === order);
      if (task) return task;
    }

    const lower = identifier.toLowerCase();
    task = state.tasks.find((t) => t.text.toLowerCase().includes(lower));
    return task;
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
          return `${icon} ${t.order}. ${t.text}${timer}${tier}${agent}`;
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
  };

  const onBeforeAgentStart = async (event: any, ctx: ExtensionContext) => {
    if (!config.enabled) return;

    if (state.tasks.length > 0) {
      const pending = state.tasks.filter((t) => t.status === "pending");
      const inProgress = state.tasks.filter((t) => t.status === "in_progress");
      const done = state.tasks.filter((t) => t.status === "done");

      const tierTag = (t: PlanTask) =>
        config.trimegisto ? ` (→ ${resolveEffectiveTier(t.tier, tgConfig)})` : "";

      const planFile = planFileNameFor(config.planFilePrefix, state.title, sessionId);
      let planContext = `[PLAN]\n${state.title} (file: ${planFile})\n`;
      planContext += `Private: never git add/commit/publish plan files; gitignore ${config.planFilePrefix}_*_[0-9a-zA-Z]*.md; no force-add.\n\n`;

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
          planContext += `- 🔄 ${t.order}. ${t.text}${tierTag(t)}${agent}\n`;
        }
        planContext += "\n";
      }

      if (pending.length > 0) {
        planContext += "Todo:\n";
        for (const t of pending.slice(0, 10)) {
          planContext += `- ⏳ ${t.order}. ${t.text}${tierTag(t)}\n`;
        }
        if (pending.length > 10) planContext += `- ... +${pending.length - 10}\n`;
        planContext += "\n";
      }

      if (done.length > 0) planContext += `Done: ${done.length}\n\n`;

      planContext += "Auto-tracks tool activity/responses. Plan changed? use plan_manager add/remove/update. Finish? [DONE:n] or plan_manager complete task_id=n. Starting? name task.\n";

      return {
        message: {
          customType: "plan-context",
          content: planContext,
          display: false,
        },
      };
    }
  };

  const onTurnEnd = async (event: any, ctx: ExtensionContext) => {
    if (!config.enabled) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);

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
        ctx.ui.notify(`+${tasks.length} tasks`, "info");
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
        return;
      }
    }

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

      const removedIds = detectRemovedTasks(text, state.tasks);
      if (removedIds.length > 0) {
        for (const id of removedIds) {
          if (removeTask(id)) changed = true;
        }
        autoNotes.push(`-${removedIds.length} stale`);
      }

      const explicitDone = parseDoneMarkers(text, state.tasks);

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
          autoNotes.push(`+${auto.completedIds.length} done`);
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
        autoNotes.push(`${auto.startedIds.length} in-progress`);
      }

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
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
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
        updateUI(ctx);
        persistState();
        await writePlanFile(ctx.cwd);
      }
    }
  };

  const onAgentEnd = async (_event: unknown, ctx: ExtensionContext) => {
    if (!config.enabled) return;
    updateUI(ctx);
  };

  const onAgentSettled = async (_event: unknown, ctx: ExtensionContext) => {
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
    ctx.ui.notify(`⏸ ${stillActive.length} paused`, "info");
  };

  const onSessionShutdown = async (_event: unknown, ctx: ExtensionContext) => {
    stopAllTimers();
    if (config.enabled && state.tasks.length > 0) {
      await writePlanFile(ctx.cwd);
    }
    persistState();
  };

  const planManagerTool = {
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: ExtensionContext) {
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
            content: [{ type: "text", text: `✓ ${task.text}` }],
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
            content: [{ type: "text", text: `▶ ${task.text}` }],
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
  };

  return {
    tPlanCommand,
    taskCommand,
    shortcut,
    onSessionStart,
    onBeforeAgentStart,
    onTurnEnd,
    onAgentEnd,
    onAgentSettled,
    onSessionShutdown,
    planManagerTool,
  };
}
