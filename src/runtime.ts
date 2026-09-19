
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type SettingItem, SettingsList, SelectList, Text, Editor, type EditorMenuEntry } from "@earendil-works/pi-tui";
import type { PlanTask, PlanState, PlanConfig, TaskStatus, Tier, PlanSession } from "./types.ts";
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
  parsePlanSessions,
  planFileNameFor,
  planTitle,
  slugify,
  titleToProjectName,
  hasRealPlanStructure,
  splitSegments,
  taskTextScore,
} from "./utils.ts";
import { readFile, writeFile, appendFile, access, unlink, mkdir, readdir, stat, rename } from "node:fs/promises";
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
  // Concurrencia entre sesiones: mtime del último plan que escribimos y marca de
  // que el fichero lo tocó otro proceso (se avisa en el siguiente updateUI).
  let lastPlanMtime: number | undefined;
  let pendingForeignWrite: number | undefined;

  // ── Evidencia del run en curso ────────────────────────────────────────
  // Qué ficheros/comandos tocó realmente el agente: señal determinista e
  // independiente del idioma para avanzar/completar tareas.
  let evidence = createEvidence();
  let lastStopReason: string | undefined;   // "stop" | "aborted" | "error" | ...
  let lastAssistantText = "";               // último texto del modelo (para el settle)

  // ── Liveness: ¿esta tarea la está ejecutando alguien AHORA? ──────────
  // `in_progress` es una intención persistida, no una prueba de ejecución: sin
  // run activo ni agente vivo el widget debe pintarla parada (ver isTaskLive).
  // runActive va de before_agent_start a agent_settled; las tareas de agente
  // (trimegisto) se consideran vivas mientras su agentId siga tracked.
  let runActive = false;
  const liveAgentTaskIds = new Set<string>();

  function isTaskLive(task: PlanTask): boolean {
    return task.status === "in_progress" && (runActive || liveAgentTaskIds.has(task.id));
  }

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

  /**
   * Records the current pi session in the plan's session history (shared plan file).
   * Capped to the newest 20 by last activity, newest first.
   */
  function touchSession(id: string | undefined, at: number, title?: string): void {
    if (!id) return;
    const sessions = state.sessions ?? [];
    const existing = sessions.find((s) => s.id === id);
    if (existing) {
      existing.lastSeenAt = at;
      if (title) existing.title = title;
    } else {
      sessions.push({ id, startedAt: at, lastSeenAt: at, ...(title ? { title } : {}) });
    }
    state.sessions = sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 20);
  }

  /**
   * Merges parsed sessions into state.sessions: dedupe by id keeping the earliest
   * startedAt and the latest lastSeenAt, newest-first, capped to 20. Shared by the
   * adopt path and the foreign-write guard so both produce the same shape.
   */
  function mergeSessionsIntoState(fileSessions: PlanSession[]): void {
    if (fileSessions.length === 0) return;
    const byId = new Map<string, PlanSession>();
    for (const s of [...(state.sessions ?? []), ...fileSessions]) {
      const prev = byId.get(s.id);
      byId.set(
        s.id,
        prev
          ? {
              ...prev,
              startedAt: Math.min(prev.startedAt, s.startedAt),
              lastSeenAt: Math.max(prev.lastSeenAt, s.lastSeenAt),
              title: prev.title ?? s.title,
            }
          : s
      );
    }
    state.sessions = [...byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 20);
  }

  function persistState(): void {
    touchSession(sessionId, Date.now());
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

  /**
   * Aparca a `pending` todo `in_progress` (limpiando `startedAt`) cuando no hay
   * ningún run/agente en marcha. Se usa al arrancar la sesión: un `in_progress`
   * leído del plan file o restaurado de otra vida no lo está ejecutando nadie, y
   * dejarlo animado con un timer viejo es exactamente el bug que se corrige.
   * Devuelve true si cambió algo.
   */
  function parkStaleInProgress(): boolean {
    let changed = false;
    for (const t of state.tasks) {
      if (t.status === "in_progress") {
        t.status = "pending";
        t.startedAt = undefined;
        changed = true;
      }
    }
    if (changed) liveAgentTaskIds.clear();
    return changed;
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

    const fileName = planFileNameFor(config.planFilePrefix, state.title);
    const filePath = join(cwd, fileName);
    if (lastPlanFile && lastPlanFile !== filePath) {
      try {
        await unlink(lastPlanFile);
      } catch {
      }
    }
    // Foreign-write guard: otra sesión pudo escribir el mismo plan compartido desde
    // nuestro último write. Se comprueba ANTES de serializar para que el historial
    // ajeno quede incluido en el fichero; las tareas siguen siendo last-write-wins.
    // Comparación estricta: nuestro propio write deja el mtime exactamente igual
    // (lo guardamos del stat posterior), así que sólo un tercero lo hace mayor.
    // Sin tolerancia: dos sesiones en ráfaga (<1 ms) también deben detectarse.
    try {
      const st = await stat(filePath);
      if (lastPlanMtime !== undefined && st.mtimeMs > lastPlanMtime) {
        const disk = await readFile(filePath, "utf-8");
        mergeSessionsIntoState(parsePlanSessions(disk));
        pendingForeignWrite = Date.now();
      }
    } catch {
      // El fichero aún no existe (primer write): no hay nada con qué comparar.
    }

    // Se construye DESPUÉS del merge: en modo trimegisto es una copia y debe
    // capturar el `sessions` ya fusionado (si no, la sesión ajena no se escribe).
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
      const st2 = await stat(filePath);
      lastPlanMtime = st2.mtimeMs;
      await ensurePlanFileGitIgnored(cwd, config.planFilePrefix);
    } catch (err) {
      logError("writePlanFile", err);
    }
  }

  /** Slug of the current plan title, used to match legacy files to this project. */
  function currentPlanSlug(): string {
    return slugify(titleToProjectName(state.title)) || "untitled";
  }

  /**
   * Adopts title, tasks and session history parsed from a plan file. Tasks are only
   * replaced when the file carries tasks; the session history is merged so a shared
   * file never loses sessions already recorded by the current run.
   */
  async function adoptPlanContent(content: string, filePath: string): Promise<boolean> {
    // minLength 1: un fichero de plan puede contener tareas cortas legítimas ("CI", "v2").
    const tasks = extractPlanTasks(content, { minLength: 1 });
    const fileSessions = parsePlanSessions(content);
    const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (h1 && h1 !== state.title) {
      state.title = h1;
      state.titleAuto = false; // a different title belongs to that project
    }
    if (tasks.length > 0) {
      assignRefs(tasks);
      state.tasks = tasks;
    }
    mergeSessionsIntoState(fileSessions);
    // Best-effort: recuerda el mtime del fichero adoptado para poder distinguir
    // después un write ajeno (otra sesión) de nuestro propio write.
    try {
      const st = await stat(filePath);
      lastPlanMtime = st.mtimeMs;
    } catch {
      lastPlanMtime = undefined;
    }
    const adopted = tasks.length > 0 || fileSessions.length > 0;
    if (adopted) {
      state.updatedAt = Date.now();
      planFilePath = filePath;
      lastPlanFile = filePath;
    }
    return adopted;
  }

  async function readPlanFile(cwd: string): Promise<boolean> {
    const filePath = join(cwd, planFileNameFor(config.planFilePrefix, state.title));
    try {
      await access(filePath);
      const content = await readFile(filePath, "utf-8");
      return adoptPlanContent(content, filePath);
    } catch (err) {
      logError("readPlanFile", err);
    }

    // Migration: plans used to live in session-scoped files. Adopt the newest legacy
    // file that matches this project's title by renaming it to the unified name.
    const slug = currentPlanSlug();
    const candidates = await scanPlanFiles({ cwd } as ExtensionContext);
    const legacy = candidates
      .filter((c) => c.legacy && (c.titleSlug ?? "").toLowerCase() === slug)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const source = legacy[0];
    if (!source) return false;

    try {
      await rename(source.file, filePath);
    } catch (err) {
      logError("readPlanFile:rename", err);
      try {
        const content = await readFile(source.file, "utf-8");
        return adoptPlanContent(content, source.file);
      } catch (inner) {
        logError("readPlanFile:legacy", inner);
        return false;
      }
    }
    try {
      const content = await readFile(filePath, "utf-8");
      return adoptPlanContent(content, filePath);
    } catch (err) {
      logError("readPlanFile:migrated", err);
      return false;
    }
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
      const patterns = [`${prefix}_*.md`];
      if (prefix === "plan") patterns.push("plan.md"); // legacy single-file plans
      const lines = content.split("\n");
      const missing = patterns.filter((p) => !lines.some((l) => l.trim() === p));
      if (missing.length === 0) return; // already covered
      const header = "# t-plan: private runtime state — never commit or publish";
      const block = [header, ...missing, ""].join("\n");
      const next = content.length === 0 || content.endsWith("\n") ? content + block : content + "\n" + block;
      await writeFile(gitignorePath, next, "utf-8");
    } catch {
    }
  }

  function startWidgetAnimation(ctx: ExtensionContext): void {
    const anyInProgress = state.tasks.some(isTaskLive);
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
    if (pendingForeignWrite !== undefined) {
      // Foreign writes are the norm in multi-agent development (several sessions
      // sharing one plan file). The merge is automatic and harmless, so we no
      // longer warn about it — it is only logged when the debug log is enabled.
      pendingForeignWrite = undefined;
      if (config.debug) {
        logError("foreignWrite", "plan file updated by another session; history merged (last-write-wins)");
      }
    }
    if (!config.enabled || !config.showWidget) {
      stopWidgetAnimation();
      ctx.ui.setStatus("t-plan", undefined);
      ctx.ui.setWidget("t-plan-tasks", undefined);
      widgetVisible = false;
      return;
    }

    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.status === "done").length;
    // Ojo: `live` (ejecutándose ahora) ≠ `in_progress` (marcada, quizá huérfana).
    // La cabecera y el spinner cuentan sólo las vivas; las in_progress sin dueño
    // activo se pintan paradas y viajan en la lista de pendientes.
    const liveCount = state.tasks.filter(isTaskLive).length;

    if (total > 0) {
      const progress = `${done}/${total}`;
      const active = liveCount > 0 ? ` ${SPINNER_FRAMES[spinnerFrame]}${liveCount}` : "";
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
        .filter((t) => isTaskLive(t) || t.status === "blocked")
        .sort((a, b) => a.order - b.order)
        .map(withTier);

      const upcoming = state.tasks
        .filter((t) => t.status === "pending" || (t.status === "in_progress" && !isTaskLive(t)))
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
            `  ${ctx.ui.theme.fg("muted", `${done}/${total} done${liveCount > 0 ? ` • ${liveCount} active` : ""}${tierSummary}`)}`,
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
              live: isTaskLive(task),
              now,
            })
          );
        }
        if (remainingCount > 0) {
          lines.push(truncateToWidth(ctx.ui.theme.fg("muted", `  +${remainingCount} more`), 78, "…"));
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
    // Sincroniza el timer con el estado, igual que markTaskStatus. Sin esto un
    // `plan_manager update` a pending dejaba el startedAt viejo y otro a
    // in_progress resucitaba un timer de días antes (el widget lo pinta parado,
    // pero el dato quedaba inconsistente).
    if (updates.status === "in_progress") {
      if (!updates.startedAt) task.startedAt = Date.now();
    } else if (updates.status === "pending") {
      task.startedAt = undefined;
      liveAgentTaskIds.delete(task.id);
    } else if (updates.status === "done") {
      task.completedAt = Date.now();
      liveAgentTaskIds.delete(task.id);
    }
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
      liveAgentTaskIds.add(existing.id);
    } else {
      const task = addTask(taskText, "in_progress");
      task.everTouched = true;
      task.agentId = agentId;
      task.agentName = agentName;
      task.startedAt = Date.now();
      liveAgentTaskIds.add(task.id);
    }
    state.updatedAt = Date.now();
  }

  function completeAgentTask(agentId: string): void {
    const task = state.tasks.find((t) => t.agentId === agentId);
    if (task) {
      task.everTouched = true;
      task.status = "done";
      task.completedAt = Date.now();
      liveAgentTaskIds.delete(task.id);
      state.updatedAt = Date.now();
    }
  }

  interface PlanFileCandidate {
    file: string;
    name: string;
    title: string;
    titleSlug: string;
    sessionId: string | undefined;
    legacy: boolean;
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
    const currentPath = join(ctx.cwd, planFileNameFor(config.planFilePrefix, state.title));
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const parsed = parsePlanFileName(name, config.planFilePrefix);
      const legacySingle = name === `${config.planFilePrefix}.md`;
      if (!parsed && !legacySingle) continue;
      const path = join(ctx.cwd, name);
      try {
        const st = await stat(path);
        const content = await readFile(path, "utf-8");
        const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const title = h1 || (parsed ? deslugTitle(parsed.titleSlug) : config.planFilePrefix);
        const tasks = extractPlanTasks(content, { minLength: 1 });
        out.push({
          file: path,
          name,
          title,
          titleSlug: parsed?.titleSlug ?? "",
          sessionId: parsed?.sessionId,
          legacy: parsed ? parsed.legacy : true,
          mtimeMs: st.mtimeMs,
          taskCount: tasks.length,
          isCurrentSession: path === currentPath,
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
      const legacyTag = c.legacy ? " (legacy)" : "";
      return `${i + 1}. ${c.title}${mark}${legacyTag} · ${c.taskCount} tasks · ${fmt.format(c.mtimeMs)}`;
    });
    const choice = await ctx.ui.select("Load plan:", labels);
    if (!choice) return;

    const target = candidates[Number.parseInt(choice, 10) - 1];
    if (!target) return;

    try {
      const content = await readFile(target.file, "utf-8");
      const tasks = extractPlanTasks(content, { minLength: 1 });
      if (tasks.length === 0) {
        ctx.ui.notify(`no tasks in ${target.name}`, "warning");
        return;
      }
      await adoptPlanContent(content, target.file);
      updateUI(ctx);
      persistState();
      await writePlanFile(ctx.cwd); // migrates a loaded legacy file to the unified name
      ctx.ui.notify(`loaded ${tasks.length}`, "info");
      if (target.legacy && target.sessionId) {
        ctx.ui.notify(`resume: pi --session ${target.sessionId}`, "info");
      }
    } catch (err) {
      logError("pickAndLoadPlan", err);
      ctx.ui.notify(`read fail: ${target.name}`, "error");
    }
  }

  const tPlanCommand = {
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      // A reload of the extension (MV3) may not re-fire session_start, leaving
      // `state` uninitialized. Guard so any slash command survives it.
      if (!state || !state.tasks) {
        state = { ...DEFAULT_STATE, tasks: [], createdAt: Date.now(), updatedAt: Date.now() };
      }
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

      if (subcommand === "edit") {
        await showEditUI(ctx);
        updateUI(ctx);
        persistState();
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
          lastPlanMtime = undefined;
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
        const ok = await ctx.ui.confirm("Clear plan?", "Remove all tasks?");
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
          "Delete all tasks, state, and the plan file (no undo)."
        );
        if (ok) {
          // Resolve the file name BEFORE resetting the title, otherwise the answer is
          // "plan_untitled.md" and the real project file survives the purge.
          const planFile = join(ctx.cwd, planFileNameFor(config.planFilePrefix, state.title));
          state = {
            ...DEFAULT_STATE,
            tasks: [],
            title: DEFAULT_STATE.title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          try {
            await unlink(planFile);
            lastPlanFile = undefined;
          } catch {
          }
          planFilePath = "";
          lastPlanMtime = undefined;
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
          const pick = await ctx.ui.select("Tier:", ["t0 (active)", "t1 (complex)", "t2 (medium)", "t3 (simple)"]);
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
        `/task <action> [args]:
  add [text] [t0-t3]
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

  // ── Config menu ───────────────────────────────────────────────────────
  // One item per setting, each with a description that is rendered under the
  // list when the item is selected (same shape as pi's native /settings).
  const ON = "on";
  const OFF = "off";

  function toggle(ctx: ExtensionContext, id: string, on: boolean): void {
    switch (id) {
      case "enabled":
        config.enabled = on;
        state.enabled = on;
        break;
      case "autoDetect":
        config.autoDetect = on;
        state.autoDetect = on;
        break;
      case "showWidget":
        config.showWidget = on;
        state.showWidget = on;
        break;
      case "trackAgents":
        config.trackAgents = on;
        break;
      case "showTimers":
        config.showTimers = on;
        break;
      case "toolEvidence":
        config.toolEvidence = on;
        ctx.ui.notify(on ? "Tool evidence ON: files/commands complete tasks" : "Tool evidence OFF: text/markers only", "info");
        break;
      case "debug":
        config.debug = on;
        ctx.ui.notify(on ? `Debug log ON: ${DEBUG_LOG_PATH}` : "Debug log OFF", "info");
        break;
      case "animateWidget":
        config.animateWidget = on;
        break;
      case "compactTaskLines":
        config.compactTaskLines = on;
        break;
      case "highlightCompleted":
        config.highlightCompleted = on;
        break;
    }
  }

  /**
   * A one-entry SelectList used as the submenu for action items (Save/Load/Clear/
   * Purge). Selecting the entry calls done("run"), which makes SettingsList fire
   * onChange(id, "run") → applyConfigChoice. Escape cancels without running.
   */
  function actionSubmenu(action: string, done: (value?: string) => void, fallbackTheme?: { fg: (c: string, s: string) => string }): SelectList {
    const t = fallbackTheme;
    const selectTheme = {
      selectedPrefix: (s) => (t ? t.fg("accent", s) : s),
      selectedText: (s) => (t ? t.fg("accent", s) : s),
      description: (s) => (t ? t.fg("muted", s) : s),
      scrollInfo: (s) => (t ? t.fg("muted", s) : s),
      noMatch: (s) => (t ? t.fg("muted", s) : s),
    };
    const labels: Record<string, string> = {
      save: "Run — write the plan file now",
      load: "Run — parse the plan file now",
      clear: "Run — remove every task (file untouched)",
      purge: "Run — delete tasks, state and the plan file",
    };
    const list = new SelectList(
      [{ value: "run", label: action, description: labels[action] ?? "Run" }],
      5,
      selectTheme
    );
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    return list;
  }

  function configItems(fallbackTheme?: { fg: (c: string, s: string) => string; bold?: (s: string) => string }): SettingItem[] {
    const onOff = (v: boolean) => (v ? ON : OFF);
    return [
      {
        id: "enabled",
        label: "📋 Plan tracking",
        currentValue: onOff(config.enabled),
        values: [ON, OFF],
        description: "Enable or disable the whole extension: the widget, the plan_manager tool and plan detection. /t-plan alone flips the same flag.",
      },
      {
        id: "autoDetect",
        label: "🔎 Auto-detect plans",
        currentValue: onOff(config.autoDetect),
        values: [ON, OFF],
        description: "Read the plan out of the model's own output (numbered steps, TODO lists, 'Done (3/8)') and reconcile it with the live task list. Off: only explicit plan_manager / task calls change the plan.",
      },
      {
        id: "showWidget",
        label: "🎛️ Task widget",
        currentValue: onOff(config.showWidget),
        values: [ON, OFF],
        description: "Show the plan above or below the editor: every task with its #ref, status, tier and elapsed time.",
      },
      {
        id: "widgetPlacement",
        label: "📐 Widget placement",
        currentValue: config.widgetPlacement,
        values: ["aboveEditor", "belowEditor"],
        description: "Where the widget sits. 'aboveEditor' is the default so the plan stays visible while you type.",
      },
      {
        id: "planFilePrefix",
        label: "📄 Plan file prefix",
        currentValue: config.planFilePrefix,
        submenu: (_current, done) => {
          // Free-text prefix. A one-entry SelectList is the only submenu shape
          // SettingsList accepts, so the prompt itself lives in this item's
          // description and the single entry opens the input dialog.
          const t = fallbackTheme;
          const selectTheme = {
            selectedPrefix: (s) => (t ? t.fg("accent", s) : s),
            selectedText: (s) => (t ? t.fg("accent", s) : s),
            description: (s) => (t ? t.fg("muted", s) : s),
            scrollInfo: (s) => (t ? t.fg("muted", s) : s),
            noMatch: (s) => (t ? t.fg("muted", s) : s),
          };
          const list = new SelectList(
            [{ value: "prompt", label: "Change prefix…", description: "Opens a prompt for the new prefix" }],
            5,
            selectTheme
          );
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(undefined);
          return list;
        },
        description: "Name of the plan file: <prefix>_<project-slug>.md, one file per project (never session-scoped), kept gitignored. Changing it merges the old file into the new name so no task is orphaned. Enter to change; Esc cancels.",
      },
      {
        id: "trackAgents", label: "🤝 Track agents", currentValue: onOff(config.trackAgents), values: [ON, OFF],
        description: "Count Trimegisto sub-agents as live work: an in_progress task stays 'running' while its agent is still alive, and shows as paused when nobody is executing it.",
      },
      {
        id: "trimegisto", label: "⚡ Trimegisto mode", currentValue: onOff(config.trimegisto), values: [ON, OFF],
        description: "Classify every task into tiers (t1 plan / t2 solve / t3 execute) and show which tiers are actually spawnable from ~/.pi/agent/trimegisto/config.json. Unavailable tiers fall back to active.",
      },
      {
        id: "showTimers", label: "⏱️ Task timers", currentValue: onOff(config.showTimers), values: [ON, OFF],
        description: "Live HH:MM:SS counter on in-progress tasks; completed tasks record '(took HH:MM:SS)' in the plan file.",
      },
      {
        id: "toolEvidence", label: "🧪 Tool evidence", currentValue: onOff(config.toolEvidence), values: [ON, OFF],
        description: "Let real work count as proof: writing a file or running a command that matches a task advances or completes it, instead of relying only on what the model says.",
      },
      {
        id: "debug", label: "🐛 Debug log", currentValue: onOff(config.debug), values: [ON, OFF],
        description: `Write swallowed errors to ~/.pi/agent/t-plan/debug.log. Off by default: no disk writes except the plan file.`,
      },
      {
        id: "animateWidget", label: "✨ Animate widget", currentValue: onOff(config.animateWidget), values: [ON, OFF],
        description: "Spinner on running tasks and a short flash on completed ones. Off keeps the widget static (cheaper renders).",
      },
      {
        id: "compactTaskLines", label: "📝 Compact task lines", currentValue: onOff(config.compactTaskLines), values: [ON, OFF],
        description: "Truncate each task to one line in the widget so the plan fits in a few rows.",
      },
      {
        id: "highlightCompleted", label: "💡 Highlight completed", currentValue: onOff(config.highlightCompleted), values: [ON, OFF],
        description: "Briefly illuminate a task after it finishes before it leaves the pending list, so closures are visible.",
      },
      // Actions are one-shot, not settings. SettingsList.activateItem() is a no-op
      // for items without `values`, so they use a submenu: selecting its only entry
      // calls done("run") → onChange("save", "run") → applyConfigChoice. Esc cancels.
      // currentValue is required by SettingItem (it is rendered), and applyConfigChoice
      // only ever writes keys it knows, so the placeholder never reaches config.
      {
        id: "save", label: "💾 Save plan file", currentValue: "—",
        submenu: (_current, done) => actionSubmenu("save", done, fallbackTheme),
        description: "Write the live plan to <prefix>_<project-slug>.md in this project.",
      },
      {
        id: "load", label: "📂 Load plan file", currentValue: "—",
        submenu: (_current, done) => actionSubmenu("load", done, fallbackTheme),
        description: "Parse the project's plan file back into the live plan (status sections, refs, tiers, timers and session history included).",
      },
      {
        id: "clear", label: "🗑️ Clear tasks", currentValue: "—",
        submenu: (_current, done) => actionSubmenu("clear", done, fallbackTheme),
        description: "Remove every task from the live plan. The plan file on disk is left untouched.",
      },
      {
        id: "purge", label: "🧹 Purge plan", currentValue: "—",
        submenu: (_current, done) => actionSubmenu("purge", done, fallbackTheme),
        description: "Delete all tasks, reset state and remove the project's plan file. Runs from the submenu, then asks for confirmation.",
      },
    ];
  }

  async function applyConfigChoice(ctx: ExtensionContext, id: string, value: string): Promise<void> {
    if (id === "widgetPlacement") {
      config.widgetPlacement = value === "belowEditor" ? "belowEditor" : "aboveEditor";
      state.widgetPlacement = config.widgetPlacement;
      return;
    }
    if (id === "planFilePrefix") {
      const name = await ctx.ui.input("Prefix (<prefix>_<title>.md):", config.planFilePrefix);
      if (!name) return;
      const next = slugify(name) || "plan";
      if (next === config.planFilePrefix) return;
      const before = planFileNameFor(config.planFilePrefix, state.title);
      const after = planFileNameFor(next, state.title);
      if (before === after) {
        config.planFilePrefix = next;
        lastPlanFile = undefined;
        lastPlanMtime = undefined;
        return;
      }
      // The name would change for this project. If a file already lives at the
      // new name, merge both plans (the live state wins) so no task is orphaned;
      // otherwise the single plan file simply moves.
      try {
        // Commit the rename first: writePlanFile() derives its path from the
        // prefix, so it must see the new one. We then explicitly remove the
        // old-named file: writePlanFile only unlinks `lastPlanFile`, which a
        // prior rename in this same session may have cleared to undefined, so
        // the explicit unlink is the authoritative move (no-op if already gone).
        config.planFilePrefix = next;
        if (await access(join(ctx.cwd, after)).then(() => true, () => false)) {
          const saved = state.tasks; // keep the live task list as the source of truth
          await adoptPlanContent(await readFile(join(ctx.cwd, after), "utf-8"), join(ctx.cwd, after));
          state.tasks = saved.length > 0 ? saved : state.tasks;
          state.updatedAt = Date.now();
        }
        await writePlanFile(ctx.cwd);
        try { await unlink(join(ctx.cwd, before)); } catch { }
        lastPlanFile = undefined;
        lastPlanMtime = undefined;
        ctx.ui.notify(`Prefix '${next}': ${before} -> ${after}`, "info");
      } catch (err) {
        logError("prefixChange", err);
        ctx.ui.notify(`Prefix '${next}' ignored: this project already uses '${before}'`, "warning");
      }
      return;
    }
    if (id === "trimegisto") {
      config.trimegisto = value === ON;
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
      return;
    }
    if (id === "save") {
      await writePlanFile(ctx.cwd);
      ctx.ui.notify("Saved", "info");
      return;
    }
    if (id === "load") {
      const loaded = await readPlanFile(ctx.cwd);
      ctx.ui.notify(loaded ? "Loaded" : "No plan file", loaded ? "info" : "warning");
      return;
    }
    if (id === "clear") {
      const ok = await ctx.ui.confirm("Clear?", "Remove all tasks?");
      if (ok) {
        state.tasks = [];
        state.updatedAt = Date.now();
      }
      return;
    }
    if (id === "purge") {
      const ok = await ctx.ui.confirm("Purge plan?", "Delete all tasks, state, and the plan file?");
      if (ok) {
        const planFile = join(ctx.cwd, planFileNameFor(config.planFilePrefix, state.title));
        state = {
          ...DEFAULT_STATE,
          tasks: [],
          title: "",
          titleAuto: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        try {
          await unlink(planFile);
          lastPlanFile = undefined;
        } catch {
        }
        planFilePath = "";
        lastPlanMtime = undefined;
        ctx.ui.notify("purged", "info");
      }
      return;
    }
    toggle(ctx, id, value === ON);
  }

  async function showConfigMenu(ctx: ExtensionContext): Promise<void> {

    // No TUI (rpc/json/print): fall back to the plain select dialog so the
    // command still works headlessly and in tests.
    if (typeof ctx.ui.custom !== "function") {
      const legacy = [
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
      const choice = await ctx.ui.select("Plan config:", legacy);
      if (!choice) return;
      if (choice.includes("Track")) await applyConfigChoice(ctx, "enabled", config.enabled ? OFF : ON);
      else if (choice.includes("Auto-detect")) await applyConfigChoice(ctx, "autoDetect", config.autoDetect ? OFF : ON);
      else if (choice.includes("Widget:")) await applyConfigChoice(ctx, "showWidget", config.showWidget ? OFF : ON);
      else if (choice.includes("Placement")) await applyConfigChoice(ctx, "widgetPlacement", config.widgetPlacement === "aboveEditor" ? "belowEditor" : "aboveEditor");
      else if (choice.includes("Prefix:")) await applyConfigChoice(ctx, "planFilePrefix", "pick");
      else if (choice.includes("Agents:")) await applyConfigChoice(ctx, "trackAgents", config.trackAgents ? OFF : ON);
      else if (choice.includes("TG")) await applyConfigChoice(ctx, "trimegisto", config.trimegisto ? OFF : ON);
      else if (choice.includes("Timers")) await applyConfigChoice(ctx, "showTimers", config.showTimers ? OFF : ON);
      else if (choice.includes("Tool evidence")) await applyConfigChoice(ctx, "toolEvidence", config.toolEvidence ? OFF : ON);
      else if (choice.includes("Debug log")) await applyConfigChoice(ctx, "debug", config.debug ? OFF : ON);
      else if (choice.includes("Animate")) await applyConfigChoice(ctx, "animateWidget", config.animateWidget ? OFF : ON);
      else if (choice.includes("Compact")) await applyConfigChoice(ctx, "compactTaskLines", config.compactTaskLines ? OFF : ON);
      else if (choice.includes("Highlight")) await applyConfigChoice(ctx, "highlightCompleted", config.highlightCompleted ? OFF : ON);
      else if (choice.startsWith("💾")) await applyConfigChoice(ctx, "save", "run");
      else if (choice.startsWith("📂")) await applyConfigChoice(ctx, "load", "run");
      else if (choice.startsWith("🗑️")) await applyConfigChoice(ctx, "clear", "run");
      else if (choice.startsWith("🧹")) await applyConfigChoice(ctx, "purge", "run");
      updateUI(ctx);
      persistState();
      return;
    }

    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("t-plan config (Enter/Space to change, Esc to close, type to search")), 1, 1));
      // getSettingsListTheme() reads the global theme singleton, which is only
      // initialized in interactive mode. Fall back to the theme handed to us by
      // ctx.ui.custom so the dialog also works in rpc/print contexts.
      let listTheme;
      try {
        listTheme = getSettingsListTheme();
      } catch {
        listTheme = {
          label: (text, selected) => theme.fg(selected ? "accent" : "text", text),
          value: (text, selected) => theme.fg(selected ? "accent" : "muted", text),
          description: (text) => theme.fg("muted", text),
          cursor: theme.fg("accent", "›"),
          hint: (text) => theme.fg("dim", text),
        };
      }
      const list = new SettingsList(
        configItems(theme),
        Math.min(configItems(theme).length + 2, 15),
        listTheme,
        (id, value) => {
          applyConfigChoice(ctx, id, value)
            .then(() => {
              updateUI(ctx);
              persistState();
            })
            .catch((err) => logError("applyConfigChoice", err));
        },
        () => done(undefined),
        { enableSearch: true }
      );
      container.addChild(list);
      return {
        list,
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  }

  /**
   * Fullscreen edit mode for the plan, invoked via `/t-plan edit`.
   *
   * Two-pane alt-screen overlay:
   *   left  – task list (select / scroll / search)
   *   right – detail: edit title, add notes, delete, reorder, launch
   *
   * Headless fallback: when the UI has no render target (tests / CI), the user's
   * keystrokes are replayed as TUI commands so the mode is still exercisable.
   */
  async function showEditUI(ctx: ExtensionContext): Promise<void> {
    const sorted = () =>
      [...state.tasks].sort((a, b) => a.order - b.order);

    const statusIcon = (t: PlanTask) =>
      t.status === "done" ? "✅" :
      t.status === "in_progress" ? (isTaskLive(t) ? "🔄" : "⏸") :
      t.status === "blocked" ? "🚫" : "⏳";

    const tierLabel = (t: PlanTask) =>
      config.trimegisto ? ` ${resolveEffectiveTier(t.tier, tgConfig)}` : "";

    const listLabel = (t: PlanTask) =>
      `${statusIcon(t)} #${t.ref}. ${t.text}${tierLabel(t)}`;

    // The fullscreen edit UI is registered through `ctx.ui.custom`, which hands
    // us the real `tui` + `theme` (required to construct the `Editor` component).
    // In headless/test mode `ctx.ui.custom` is a queue of commands instead: we
    // drain it here so the SAME interactive code path runs.
    const custom = ctx.ui.custom as any;
    if (!custom || typeof custom !== "function") {
      const target = custom ?? (ctx.ui.custom = {});
      const queue = target.editCommands ?? [];
      // Structural ops (/del, /up, /down) act on the selected task; default to
      // the last task (bottom of the list), matching the interactive default.
      target.editSelected = Math.max(0, state.tasks.length - 1);
      for (const raw of queue) {
        const cmd = String(raw).trim();
        if (!cmd) continue;
        if (cmd === "/cancel" || cmd.toLowerCase() === "exit") break;
        await handleEditCommand(ctx, cmd);
      }
      return;
    }

    await custom(async (tui, theme, _kb, done) => {
      const container = new Container({ direction: "vertical", gap: 0, expand: true });

      const list = new SelectList(
        sorted().map(listLabel),
        Math.min(state.tasks.length, 12),
        undefined,
        () => {},
        () => { done(undefined); },
        { enableSearch: true }
      );
      // Structural ops (/del, /up, /down) act on the selected task; annotate/run
      // ops act on the first task. Default selection = last item (bottom of the
      // list), which is where a fresh editor lands after adding a task.
      if (state.tasks.length > 0) list.selected = state.tasks.length - 1;
      (ctx.ui.custom as any).editSelected = list.selected ?? 0;

      const detail = new Text({ expand: true, wrap: true });
      const renderDetail = () => {
        const sel = list.selected ?? 0;
        const task = sorted()[sel];
        if (!task) {
          detail.value = "No task selected.";
          return;
        }
        const lines = [
          `${statusIcon(task)} #${task.ref}${tierLabel(task)}`,
          task.text,
          "",
          `Status: ${task.status}`,
          task.notes ? `\nNotes:\n${task.notes}` : "",
          "",
          "Commands: /note /edit /run /up /down /del /add /cancel",
        ];
        detail.value = lines.join("\n");
      };

      const editor = new Editor(tui, theme, {
        placeholder: "command… /up · /down · /del · /note · /edit · /run · /add <text> · /cancel",
      });
      editor.onSubmit = async (value: string) => {
        await handleEditCommand(ctx, value.trim());
      };

      container.addChild(list);
      container.addChild(detail);
      container.addChild(editor);

      const render = () => container.render(tui.terminal.columns);
      render();
      editor.focus();

      // --- Command loop: process queued edit commands, keep UI live --------
      // In interactive mode the queue is empty and we await the editor's
      // onSubmit/escape; in headless/test mode the queue is drained here so the
      // exact same code runs.
      const queue = (ctx.ui.custom as any)?.editCommands ?? [];
      let idx = 0;
      let doneFlag = false;
      const resolveDone = () => { if (!doneFlag) { doneFlag = true; done(undefined); } };

      const loop = async () => {
        while (!doneFlag) {
          const labels = sorted().map(listLabel);
          const selIdx = list.selected ?? 0;
          list.setItems(labels);
          list.selected = Math.min(selIdx, labels.length - 1);
          (ctx.ui.custom as any).editSelected = list.selected;
          renderDetail();
          render();

          const input = queue[idx++];
          if (input === undefined) {
            // No queued command: wait for the user to submit or cancel.
            await new Promise<void>((resolve) => {
              const onDone = () => { resolve(); resolveDone(); };
              editor.onSubmit = async (value) => {
                await handleEditCommand(ctx, value.trim());
                resolve();
              };
              editor.onEscape = onDone;
            });
            continue;
          }
          const close = await handleEditCommand(ctx, String(input).trim());
          if (close) { resolveDone(); break; }
        }
      };

      // Kick off the loop. In headless/test mode it drains `queue`; in interactive
      // mode the queue is empty and it awaits the editor's onSubmit/escape (the
      // editor.onSubmit reassignment inside the await wires the real submit).
      void loop();

      return {
        render,
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          editor.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  }

  /**
   * Apply a single edit-mode command to the plan. Parses the mini-language used by
   * the fullscreen editor and mutates state. Returns true if the editor should
   * close (the `/cancel` command).
   */
  async function handleEditCommand(ctx: ExtensionContext, input: string): Promise<boolean> {
    if (!input) return false;

    const lower = input.toLowerCase();
    if (lower === "/cancel" || lower === "exit") return true;
    if (lower === "/add") {
      const title = await ctx.ui.input("New task:", "");
      if (title) { addTask(title); ctx.ui.notify(`+${title}`, "info"); updateUI(ctx); }
      return false;
    }
    if (lower.startsWith("/add ")) {
      addTask(input.slice(5).trim());
      ctx.ui.notify("added", "info");
      return false;
    }
    if (lower === "/up") {
      const idx = (ctx.ui.custom as any)?.editSelected ?? 0;
      const task = sortedForEdit()[idx];
      if (task && task.order > 1) {
        moveTask(task.id, task.order - 1);
        // Keep the selection on the moved task so repeated /up stacks upward.
        (ctx.ui.custom as any).editSelected = sortedForEdit().findIndex((x) => x.id === task.id);
        ctx.ui.notify("↑", "info");
      }
      return false;
    }
    if (lower === "/down") {
      const idx = (ctx.ui.custom as any)?.editSelected ?? 0;
      const task = sortedForEdit()[idx];
      if (task && task.order < sortedForEdit().length) {
        moveTask(task.id, task.order + 1);
        (ctx.ui.custom as any).editSelected = sortedForEdit().findIndex((x) => x.id === task.id);
        ctx.ui.notify("↓", "info");
      }
      return false;
    }
    if (lower === "/del" || lower === "/delete") {
      const t = sortedForEdit();
      const idx = (ctx.ui.custom as any)?.editSelected ?? 0;
      const task = t[idx];
      if (task) {
        removeTask(task.id);
        (ctx.ui.custom as any).editSelected = Math.min(idx, Math.max(0, t.length - 2));
        ctx.ui.notify("deleted", "info");
      }
      return false;
    }
    if (lower.startsWith("/note")) {
      const t = sortedForEdit();
      const task = t[0];
      const current = task?.notes ?? "";
      const note = await ctx.ui.input(`Notes #${task?.ref}:`, current);
      if (task && note !== undefined) { updateTask(task.id, { notes: note }); ctx.ui.notify("notes updated", "info"); }
      return false;
    }
    if (lower.startsWith("/edit")) {
      const t = sortedForEdit();
      const task = t[0];
      if (task) {
        const next = await ctx.ui.input(`Edit #${task.ref}:`, task.text);
        if (next) { updateTask(task.id, { text: next }); ctx.ui.notify("edited", "info"); }
      }
      return false;
    }
    if (lower === "/run" || lower.startsWith("/run ")) {
      const t = sortedForEdit();
      const task = t[0] ?? t[(ctx.ui.custom as any)?.editSelected ?? 0];
      await launchTaskFromEdit(ctx, task);
      return false;
    }
    // Bare number: select that ref.
    const numMatch = input.match(/^(\d+)$/);
    if (numMatch) {
      const ref = parseInt(numMatch[1], 10);
      const task = state.tasks.find((x) => x.ref === ref);
      if (task) { (ctx.ui.custom as any).editSelected = task.order - 1; ctx.ui.notify(`selected #${ref}`, "info"); }
      return false;
    }
    return false;
  }

  function sortedForEdit(): PlanTask[] {
    return [...state.tasks].sort((a, b) => a.order - b.order);
  }

  /**
   * Launch a task from edit mode: abort the current agent run (if any) and send a
   * user message that starts it, matching the `/t-run` behaviour.
   */
  async function launchTaskFromEdit(ctx: ExtensionContext, task?: PlanTask): Promise<void> {
    if (!task) return;
    // Stop whatever is currently running.
    try { await ctx.ui.abort?.(); } catch { /* best effort */ }
    const ref = task.ref;
    const msg = task.notes ? `/t-run ${ref}\n\nNotes:\n${task.notes}` : `/t-run ${ref}`;
    await ctx.ui.sendUserMessage(msg);
  }

  function editMenuEntries(ctx: ExtensionContext): EditorMenuEntry[] {
    const entries: EditorMenuEntry[] = [
      { label: "/add", description: "add task" },
      { label: "/note", description: "edit notes" },
      { label: "/edit", description: "edit title" },
      { label: "/run", description: "launch (stop current)" },
      { label: "/up", description: "move up" },
      { label: "/down", description: "move down" },
      { label: "/del", description: "delete" },
      { label: "/cancel", description: "exit" },
    ];
    return entries;
  }

  async function showReorderUI(ctx: ExtensionContext): Promise<void> {
    if (state.tasks.length === 0) {
      ctx.ui.notify("Nothing to reorder", "info");
      return;
    }

    const choice = await ctx.ui.select(
      "Move task:",
      state.tasks.map((t) => `${t.order}. ${t.text}`)
    );

    if (!choice) return;

    const order = parseInt(choice);
    const task = state.tasks.find((t) => t.order === order);
    if (!task) return;

    const newOrderStr = await ctx.ui.input("New position:", order.toString());
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
          const icon = t.status === "done" ? "✅" : t.status === "in_progress" ? (isTaskLive(t) ? "🔄" : "⏸") : t.status === "blocked" ? "🚫" : "⏳";
          const agent = t.agentName ? ` [${t.agentName}]` : "";
          const tier = config.trimegisto ? ` → ${resolveEffectiveTier(t.tier, tgConfig)}` : "";
          let timer = "";
          if (config.showTimers) {
            if (isTaskLive(t) && t.startedAt) {
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
    lastPlanMtime = undefined; // antes de leer: el mtime del disco aún no se conoce
    const entries = ctx.sessionManager.getEntries();
    config = { ...DEFAULT_CONFIG, ...globalConfigPartial };
    const hadSessionState = entries.some((e: any) => e.type === "custom" && e.customType === "plan-state");
    if (!hadSessionState) {
      state = { ...DEFAULT_STATE, tasks: [], createdAt: Date.now(), updatedAt: Date.now() };
    }
    restoreState(entries);
    ensureTitle(undefined, ctx);

    if (config.enabled) {
      // A brand-new session continues the project's shared plan file; a resumed one
      // keeps its richer in-session state and only falls back to disk when empty.
      if (!hadSessionState || state.tasks.length === 0) {
        await readPlanFile(ctx.cwd);
      }
      // Nadie está ejecutando nada al arrancar: cualquier in_progress (heredado de
      // otra vida de la sesión o adoptado del plan_*.md, con startedAt de hace días)
      // se aparca a pending. Antes sólo se hacía con hadSessionState, así que un
      // fichero de plan con in_progress antiguo se cargaba tal cual y salía girando.
      if (parkStaleInProgress()) state.updatedAt = Date.now();
      touchSession(sessionId, Date.now());
      if (state.tasks.length > 0) await writePlanFile(ctx.cwd);
      persistState();
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

    // Run en marcha: mientras dure, las tareas in_progress se consideran vivas
    // (el agente las está trabajando) y el widget las anima. agent_settled lo baja.
    runActive = true;
    // Repinta ya: si el settle anterior dejó una tarea "parada" (⏸) que ahora
    // retomamos, debe volver a girar desde el primer momento del run.
    updateUI(ctx);

    if (state.tasks.length > 0) {
      const pending = state.tasks.filter((t) => t.status === "pending");
      const inProgress = state.tasks.filter((t) => t.status === "in_progress");
      const blocked = state.tasks.filter((t) => t.status === "blocked");
      const done = state.tasks.filter((t) => t.status === "done");

      const tierTag = (t: PlanTask) =>
        config.trimegisto ? ` (→ ${resolveEffectiveTier(t.tier, tgConfig)})` : "";

      const planFile = planFileNameFor(config.planFilePrefix, state.title);
      let planContext = `[PLAN]\n${state.title} (file: ${planFile}; one per project, continues across sessions)\n`;
      planContext += `Private: never git add/commit/publish plan files (gitignore ${config.planFilePrefix}_*.md; no force-add)\n`;
      planContext += `Refs (#n) are stable: use in task_id and [DONE:#n]\n\n`;

      if (config.trimegisto) {
        const available = (["t0", "t1", "t2", "t3"] as Tier[]).filter((tier) => isTierAvailable(tier, tgConfig));
        planContext += "[TG]\n";
        planContext += "Use task →tier; unavailable => active. Batch independent. Finish => plan_manager complete.\n";
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
        if (pending.length > PENDING_CAP) planContext += `- … +${pending.length - PENDING_CAP} more (plan_manager list)\n`;
        planContext += "\n";
      }

      if (blocked.length > 0) {
        planContext += `Blocked: ${blocked.map((t) => `#${t.ref}`).join(", ")}\n\n`;
      }

      if (done.length > 0) {
        const refs = done.slice(-12).map((t) => `#${t.ref}`).join(", ");
        planContext += `Done (${done.length}): ${refs}${done.length > 12 ? ", ..." : ""}\n\n`;
      }

      planContext += "Rules: before ending the turn, plan_manager complete task_id=<ref> for EVERY finished task (accepts \"2,3\" or text). Plan changed => add/remove/update; starting => plan_manager start or name it. Auto-tracking uses touched files/commands.\n";

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
        // La prosa numerada de un resumen ("1. … 2. … 3. …") no es un plan:
        // exigir estructura real (cabeceras/checkboxes) evita tareas fantasma.
        if (hasRealPlanStructure(text) && shouldReconcilePlan(text, refreshedTasks, state.tasks)) {
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

  /**
   * ¿El texto mantiene una tarea activa (el agente dice que sigue con ella)?
   * Se usa al settle normal: si nadie trabaja ya en la tarea, no debe quedarse
   * in_progress con el timer corriendo entre mensajes del usuario.
   */
  const ACTIVE_CUE_RE =
    /(?:contin[uú]o|continuando|continuamos|contin[uú]a(?=\s+con)|sigo\s+con|siguiendo\s+con|seguimos\s+con|estoy\s+(?:con|en|trabajando\s+en)|still\s+working\s+on|keep\s+working\s+on|back\s+to|retomo|retomando|voy\s+a\s+seguir\s+con)|(?:继续|接着|还在|仍\s*在)/i;

  function taskKeptActive(task: PlanTask, text: string): boolean {
    if (!text) return false;
    for (const segment of splitSegments(text)) {
      if (!ACTIVE_CUE_RE.test(segment)) continue;
      if (taskTextScore(task.text, segment) >= 0.5 - 1e-9) return true;
    }
    return false;
  }

  const onAgentSettled = async (_event: unknown, ctx: ExtensionContext) => {
    try {
    // El run ha terminado (o se ha abortado): bajar la liveness cuanto antes para
    // que cualquier updateUI posterior pinte paradas —no girando— las in_progress
    // que sobrevivan, aunque config esté deshabilitado a mitad de run.
    runActive = false;
    liveAgentTaskIds.clear();
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
    } else {
      // Run normal: el agente queda idle. Una tarea que sigue in_progress pero que
      // este run no trabajó (sin "sigo con…" en el texto final) no la está trabajando
      // nadie ahora mismo: vuelve a pending y su timer se detiene. Antes quedaba
      // girando indefinidamente entre mensajes del usuario (queja real: "las tareas
      // siguen activas y con tu timer avanzando").
      const idle = state.tasks.filter(
        (t) =>
          t.status === "in_progress" &&
          !t.agentId && // tareas de agente (trimegisto) tienen su propio ciclo
          !taskKeptActive(t, lastAssistantText)
      );
      for (const task of idle) {
        markTaskStatus(task.id, "pending", ctx);
      }
      if (idle.length > 0) {
        changed = true;
        notes.push(`⏹ ${idle.length} idle → pending`);
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
    runActive = false;
    liveAgentTaskIds.clear();
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
              content: [{ type: "text", text: `task_id required for complete. Refs:\n${taskRefList()}` }],
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
            return { content: [{ type: "text", text: `task_id required for start. Refs:\n${taskRefList()}` }], details: {} };
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
            return { content: [{ type: "text", text: `task_id required for block. Refs:\n${taskRefList()}` }], details: {} };
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
            return { content: [{ type: "text", text: `task_id required for update. Refs:\n${taskRefList()}` }], details: {} };
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
            return { content: [{ type: "text", text: `task_id required for remove. Refs:\n${taskRefList()}` }], details: {} };
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
    configItems,
    // Read-only introspection for tests and diagnostics.
    getConfig: () => config,
    getState: () => state,
  };
}
