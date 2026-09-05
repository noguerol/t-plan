import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const tPlanCompletions = [
  { value: "on", label: "on", description: "Enable" },
  { value: "off", label: "off", description: "Disable" },
  { value: "config", label: "config", description: "Config" },
  { value: "show", label: "show", description: "Show plan" },
  { value: "new", label: "new", description: "New plan" },
  { value: "load", label: "load", description: "Load plan" },
  { value: "save", label: "save", description: "Save plan" },
  { value: "clear", label: "clear", description: "Clear tasks" },
  { value: "purge", label: "purge", description: "Purge plan" },
];

const taskCompletions = [
  { value: "add", label: "add", description: "Add" },
  { value: "done", label: "done", description: "Done" },
  { value: "remove", label: "remove", description: "Remove" },
  { value: "edit", label: "edit", description: "Edit" },
  { value: "move", label: "move", description: "Move" },
  { value: "start", label: "start", description: "Start" },
  { value: "block", label: "block", description: "Block" },
  { value: "tier", label: "tier", description: "Set tier" },
];

type Runtime = ReturnType<(typeof import("./runtime.ts"))["createPlanRuntime"]>;
let runtimePromise: Promise<Runtime> | undefined;
function runtime(pi: ExtensionAPI): Promise<Runtime> {
  return (runtimePromise ??= import("./runtime.ts").then((m) => m.createPlanRuntime(pi)));
}

const completions = <T extends { value: string }>(items: T[], prefix: string) => {
  const out = items.filter((x) => x.value.startsWith(prefix));
  return out.length ? out : null;
};

export default function planExtension(pi: ExtensionAPI): void {
  pi.registerCommand("t-plan", {
    description: "Toggle/show t-plan",
    handler: async (args: string | undefined, ctx: ExtensionContext) => (await runtime(pi)).tPlanCommand.handler(args, ctx),
    getArgumentCompletions: (prefix: string) => completions(tPlanCompletions, prefix),
  });

  pi.registerCommand("task", {
    description: "Manage plan tasks",
    handler: async (args: string | undefined, ctx: ExtensionContext) => (await runtime(pi)).taskCommand.handler(args, ctx),
    getArgumentCompletions: (prefix: string) => completions(taskCompletions, prefix),
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle t-plan",
    handler: async (ctx: ExtensionContext) => (await runtime(pi)).shortcut.handler(ctx),
  });

  pi.on("session_start", async (event, ctx) => (await runtime(pi)).onSessionStart(event, ctx));
  pi.on("before_agent_start", async (event, ctx) => (await runtime(pi)).onBeforeAgentStart(event, ctx));
  pi.on("tool_result", async (event, ctx) => (await runtime(pi)).onToolResult(event, ctx));
  pi.on("turn_end", async (event, ctx) => (await runtime(pi)).onTurnEnd(event, ctx));
  pi.on("agent_end", async (event, ctx) => (await runtime(pi)).onAgentEnd(event, ctx));
  pi.on("agent_settled", async (event, ctx) => (await runtime(pi)).onAgentSettled(event, ctx));
  pi.on("session_shutdown", async (event, ctx) => (await runtime(pi)).onSessionShutdown(event, ctx));

  pi.registerTool({
    name: "plan_manager",
    label: "T-Plan Manager",
    description: "Manage plan tasks. Trimegisto: tier t1/t2/t3, fallback t0/active.",
    promptSnippet: "Manage plan tasks: add/remove/update/start/block/complete/list.",
    promptGuidelines: [
      "Use for multi-step progress.",
      "Complete finished tasks; add new tasks.",
      "Before ending a turn, call complete for every finished task (task_id accepts \"3\", \"2,3\", \"2-4\" or task text).",
      "Use the stable #ref shown in the plan context; display order can change.",
      "Discard/split/rename/reprioritize: update/remove old tasks.",
      "Plan files are PRIVATE runtime state: never commit/publish/force-add; keep gitignored.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "complete", "update", "list", "start", "block", "remove"] as const),
      task_text: Type.Optional(Type.String({ description: "Task text (add/update)" })),
      task_id: Type.Optional(
        Type.String({ description: "Task ref/order/text; accepts lists (\"2,3\") and ranges (\"2-4\")" })
      ),
      status: Type.Optional(StringEnum(["pending", "in_progress", "done", "blocked"] as const)),
      notes: Type.Optional(Type.String({ description: "Notes" })),
      tier: Type.Optional(
        StringEnum(["t0", "t1", "t2", "t3", "active"] as const, {
          description: "Trimegisto tier; t0/active fallback. Auto-classified if omitted.",
        })
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      (await runtime(pi)).planManagerTool.execute(toolCallId, params, signal, onUpdate, ctx),
  });
}
