
import type { Tier } from "./tiers.ts";

export type { Tier } from "./tiers.ts";

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PlanTask {
  id: string;
  ref: number;             // Stable handle shown to the model (never renumbered).
                           // `order` is display-only and may be re-sorted/compacted,
                           // so [DONE:n] / task_id=n must resolve against `ref` first.
  text: string;
  status: TaskStatus;
  order: number;
  agentId?: string;        // For parallel agent tracking
  agentName?: string;      // Display name of the agent
  startedAt?: number;      // Timestamp when task started
  completedAt?: number;    // Timestamp when task completed
  notes?: string;          // Optional notes
  parentId?: string;       // For subtasks
  tier?: Tier;             // Trimegisto tier assignment (t0/t1/t2/t3)
  everTouched?: boolean;   // True once a *per-task* detection path referenced it
                           // (explicit marker, tool evidence, fuzzy completion, manual
                           // edit). Never set in bulk: at plan-conclusion, untouched
                           // pending tasks are dropped (the model registered them but
                           // never acted on them).
}

/** Tool activity observed during the current agent run (evidence for completion). */
export interface EvidenceClass {
  mutating: boolean;   // edit / write / apply_patch / multiedit (file changed)
  command: boolean;    // bash / powershell (command executed)
  read: boolean;       // read / grep / find / ls (inspection only)
}

export interface ToolEvidence {
  /** Normalized tokens extracted from tool args (paths, basenames, routes, identifiers). */
  tokens: Set<string>;
  /** Tokens seen through a file-mutating tool. */
  mutatingTokens: Set<string>;
  /** Tokens seen through a command execution. */
  commandTokens: Set<string>;
  /** Number of test/build/lint commands observed. */
  testRuns: number;
  /** Number of tool calls recorded. */
  calls: number;
}

export interface PlanState {
  enabled: boolean;
  tasks: PlanTask[];
  title: string;           // e.g. "myapp Plan" / "Plan de miapp" / "myapp 计划" (localized)
  titleAuto: boolean;      // true while the title is auto-derived (project dir + language)
  description?: string;
  createdAt: number;
  updatedAt: number;
  autoDetect: boolean;     // Auto-detect plans from model output
  showWidget: boolean;     // Show the TUI widget
  widgetPlacement: "aboveEditor" | "belowEditor";
}

export interface PlanConfig {
  enabled: boolean;
  autoDetect: boolean;
  showWidget: boolean;
  widgetPlacement: "aboveEditor" | "belowEditor";
  planFilePrefix: string;  // Plan files: <prefix>_<title-slug>_<session-id>.md. Default: "plan"
  trackAgents: boolean;    // Track parallel agent tasks
  animateWidget: boolean;  // Animate in-progress spinners and completion highlights
  compactTaskLines: boolean; // Truncate task lines to fit the widget width
  highlightCompleted: boolean; // Briefly highlight newly completed tasks before hiding them
  trimegisto: boolean;     // Trimegisto mode: classify tasks into t1/t2/t3 tiers
  showTimers: boolean;     // Show HH:MM:SS elapsed timers on in-progress tasks
  toolEvidence: boolean;   // Complete/advance tasks from real tool activity (paths touched)
  debug: boolean;          // Log swallowed errors to ~/.pi/agent/t-plan/debug.log
}

export const DEFAULT_CONFIG: PlanConfig = {
  enabled: true,
  autoDetect: true,
  showWidget: true,
  widgetPlacement: "aboveEditor",
  planFilePrefix: "plan",
  trackAgents: true,
  animateWidget: true,
  compactTaskLines: true,
  highlightCompleted: true,
  trimegisto: false,
  showTimers: true,
  toolEvidence: true,
  debug: false,
};

export const DEFAULT_STATE: PlanState = {
  enabled: true,
  tasks: [],
  title: "",              // computed at runtime: "{project} Plan" / "Plan de {project}" / "{project} 计划"
  titleAuto: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  autoDetect: true,
  showWidget: true,
  widgetPlacement: "aboveEditor",
};

export const SPINNER_FRAMES: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
