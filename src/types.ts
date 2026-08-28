/**
 * Types for the Plan extension
 */

export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PlanTask {
  id: string;
  text: string;
  status: TaskStatus;
  order: number;
  agentId?: string;        // For parallel agent tracking
  agentName?: string;      // Display name of the agent
  startedAt?: number;      // Timestamp when task started
  completedAt?: number;    // Timestamp when task completed
  notes?: string;          // Optional notes
  parentId?: string;       // For subtasks
}

export interface PlanState {
  enabled: boolean;
  tasks: PlanTask[];
  title: string;
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
  planFileName: string;    // Default: "plan.md"
  trackAgents: boolean;    // Track parallel agent tasks
  animateWidget: boolean;  // Animate in-progress spinners and completion highlights
  compactTaskLines: boolean; // Truncate task lines to fit the widget width
  highlightCompleted: boolean; // Briefly highlight newly completed tasks before hiding them
}

export const DEFAULT_CONFIG: PlanConfig = {
  enabled: true,
  autoDetect: true,
  showWidget: true,
  widgetPlacement: "aboveEditor",
  planFileName: "plan.md",
  trackAgents: true,
  animateWidget: true,
  compactTaskLines: true,
  highlightCompleted: true,
};

export const DEFAULT_STATE: PlanState = {
  enabled: true,
  tasks: [],
  title: "Project Plan",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  autoDetect: true,
  showWidget: true,
  widgetPlacement: "aboveEditor",
};

export const SPINNER_FRAMES: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
