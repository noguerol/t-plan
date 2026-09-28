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
  { value: "edit", label: "edit", description: "Edit (fullscreen)" },
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
  { value: "verify", label: "verify", description: "Verify" },
  { value: "coverage", label: "coverage", description: "Coverage" },
];

type Runtime = ReturnType<(typeof import("./runtime.ts"))["createPlanRuntime"]>;
let runtimePromise: Promise<Runtime> | undefined;
let boundPi: ExtensionAPI | undefined;
function runtime(pi: ExtensionAPI): Promise<Runtime> {
  // Tras newSession/fork/switchSession/reload, pi re-ejecuta la factory con un
  // `pi` nuevo e invalida el viejo. El runtime está cacheado (module-level), así
  // que hay que re-vincularlo al `pi` vivo o persistState() lanzaría "ctx stale"
  // en cada llamada a plan_manager.
  if (runtimePromise) {
    if (boundPi !== pi) {
      boundPi = pi;
      return runtimePromise.then((r) => {
        r.setPi(pi);
        return r;
      });
    }
    return runtimePromise;
  }
  boundPi = pi;
  return (runtimePromise = import("./runtime.ts").then((m) => m.createPlanRuntime(pi)));
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
  // `input` fires before `before_agent_start` and carries `source`:
  // marks extension-injected prompts so spec memory skips them.
  pi.on("input", async (event, ctx) => (await runtime(pi)).onInput(event, ctx));
  pi.on("before_agent_start", async (event, ctx) => (await runtime(pi)).onBeforeAgentStart(event, ctx));
  pi.on("tool_result", async (event, ctx) => (await runtime(pi)).onToolResult(event, ctx));
  pi.on("turn_end", async (event, ctx) => (await runtime(pi)).onTurnEnd(event, ctx));
  pi.on("agent_end", async (event, ctx) => (await runtime(pi)).onAgentEnd(event, ctx));
  pi.on("agent_settled", async (event, ctx) => (await runtime(pi)).onAgentSettled(event, ctx));
  pi.on("session_shutdown", async (event, ctx) => (await runtime(pi)).onSessionShutdown(event, ctx));

  pi.registerTool({
    name: "plan_manager",
    label: "Plan",
    description: "Plan tasks; tiers, lanes, coverage, verify.",
    promptSnippet: "Plan: add/plan/complete/verify/update/start/block/remove/list/coverage/source/forget.",
    promptGuidelines: [
      "Multi-step work.",
      "Complete finished tasks; add new.",
      "Before ending turn, complete every finished task (task_id: \"3\", \"2,3\", \"2-4\" or text).",
      "Use stable #ref; display order varies.",
      "Discard/split/rename/reprioritize: update/remove.",
      "Spec tasks need plan_manager verify (build/test evidence) before complete.",
      "Plan files: PRIVATE; never commit/publish/force-add; keep gitignored.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "plan", "complete", "verify", "update", "list", "coverage", "source", "forget", "start", "block", "remove"] as const),
      task_text: Type.Optional(Type.String({ description: "Text (add/update); source/forget: relative path or source id" })),
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
      lane: Type.Optional(
        StringEnum(["active", "backlog", "paused"] as const, {
          description: "Execution lane (add/plan/update). Default active.",
        })
      ),
      reqs: Type.Optional(Type.String({ description: "Requirement ids, e.g. \"R2,R5\" (add/plan/update)." })),
      check: Type.Optional(Type.String({ description: "Acceptance steps, '|'-separated (add/plan/update)." })),
    }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) =>
      (await runtime(pi)).planManagerTool.execute(toolCallId, params, signal, onUpdate, ctx),
  });
}
