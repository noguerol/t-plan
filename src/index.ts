import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const tPlanCompletions = [
  { value: "on", label: "on", description: "On" },
  { value: "off", label: "off", description: "Off" },
  { value: "config", label: "config", description: "Cfg" },
  { value: "show", label: "show", description: "Show" },
  { value: "new", label: "new", description: "New" },
  { value: "load", label: "load", description: "Load" },
  { value: "save", label: "save", description: "Save" },
  { value: "clear", label: "clear", description: "Clear" },
  { value: "purge", label: "purge", description: "Purge" },
];

const taskCompletions = [
  { value: "add", label: "add", description: "Add" },
  { value: "done", label: "done", description: "Done" },
  { value: "remove", label: "remove", description: "Remove" },
  { value: "edit", label: "edit", description: "Edit" },
  { value: "move", label: "move", description: "Move" },
  { value: "start", label: "start", description: "Start" },
  { value: "block", label: "block", description: "Block" },
  { value: "tier", label: "tier", description: "Tier" },
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
    description: "Toggle",
    handler: async (args: string | undefined, ctx: ExtensionContext) => (await runtime(pi)).tPlanCommand.handler(args, ctx),
    getArgumentCompletions: (prefix: string) => completions(tPlanCompletions, prefix),
  });

  pi.registerCommand("task", {
    description: "Tasks",
    handler: async (args: string | undefined, ctx: ExtensionContext) => (await runtime(pi)).taskCommand.handler(args, ctx),
    getArgumentCompletions: (prefix: string) => completions(taskCompletions, prefix),
  });

  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle",
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
    label: "Plan",
    description: "Plan tasks; tiers t1/t2/t3, fallback t0.",
    promptSnippet: "Plan tasks: add/remove/update/start/block/complete/list.",
    promptGuidelines: [
      "Multi-step work.",
      "Complete finished tasks; add new.",
      "Before ending turn, complete every finished task (task_id: \"3\", \"2,3\", \"2-4\" or text).",
      "Use stable #ref; display order varies.",
      "Discard/split/rename/reprioritize: update/remove.",
      "Plan files: PRIVATE; never commit/publish/force-add; keep gitignored.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "complete", "update", "list", "start", "block", "remove"] as const),
      task_text: Type.Optional(Type.String({ description: "Text (add/update)" })),
      task_id: Type.Optional(
        Type.String({ description: "Ref/order/text; lists \"2,3\", ranges \"2-4\"" })
      ),
      status: Type.Optional(StringEnum(["pending", "in_progress", "done", "blocked"] as const)),
      notes: Type.Optional(Type.String({ description: "Notes" })),
      tier: Type.Optional(
        StringEnum(["t0", "t1", "t2", "t3", "active"] as const, {
          description: "Tier; t0/active fallback if omitted.",
        })
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      (await runtime(pi)).planManagerTool.execute(toolCallId, params, signal, onUpdate, ctx),
  });
}
