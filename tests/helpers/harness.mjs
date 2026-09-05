/**
 * Arnés mínimo para ejercitar el runtime de t-plan sin pi: `createPlanRuntime(pi)`
 * sólo usa pi.appendEntry, y el ctx de extensión se limita a ui.* + cwd + sessionManager.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createHarness() {
  // HOME temporal: ni el config global del usuario (~/.pi/agent/t-plan/config.json)
  // ni el de trimegisto pueden alterar el comportamiento bajo test.
  const prevHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), "tplan-home-"));
  process.env.HOME = home;
  const { createPlanRuntime } = await import("../../src/runtime.ts");

  const entries = [];
  const notes = [];
  const widgets = new Map();
  const cwd = await mkdtemp(join(tmpdir(), "tplan-test-"));

  const pi = {
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };

  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    ui: {
      notify: (msg, level) => notes.push({ msg, level }),
      setStatus: () => {},
      setWidget: (id, lines) => widgets.set(id, lines),
      theme: {
        bold: (s) => s,
        fg: (_c, s) => s,
        bg: (_c, s) => s,
        strikethrough: (s) => s,
      },
      select: async () => undefined,
      confirm: async () => true,
      input: async () => "",
    },
    sessionManager: {
      getSessionId: () => "sess1234abcd",
      getEntries: () => entries,
    },
  };

  const rt = createPlanRuntime(pi);
  await rt.onSessionStart({}, ctx);

  const tool = async (params) =>
    rt.planManagerTool.execute("call_1", params, undefined, undefined, ctx);

  async function addTasks(texts) {
    for (const text of texts) await tool({ action: "add", task_text: text });
  }

  /** [{ ref, text, status }] a partir de `plan_manager list`. */
  async function plan() {
    const res = await tool({ action: "list" });
    return (res.content[0].text.split("\n").slice(2))
      .filter(Boolean)
      .map((line) => {
        const icon = line.startsWith("✅") ? "done" : line.startsWith("🔄") ? "in_progress" : line.startsWith("🚫") ? "blocked" : "pending";
        const m = line.match(/^.\s*#(\d+)\.\s*(.*)$/u);
        return { ref: m ? Number(m[1]) : NaN, text: m ? m[2].trim() : line, status: icon };
      });
  }

  const statusByRef = async () => Object.fromEntries((await plan()).map((t) => [t.ref, t.status]));

  async function runStart() {
    return rt.onBeforeAgentStart({ prompt: "go", systemPrompt: "" }, ctx);
  }

  async function toolResult(toolName, input, isError = false) {
    await rt.onToolResult({ type: "tool_result", toolName, input, isError }, ctx);
  }

  async function turnEnd(text, stopReason = "stop", toolResults = []) {
    await rt.onTurnEnd(
      {
        type: "turn_end",
        turnIndex: 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason,
          usage: {},
        },
        toolResults,
      },
      ctx
    );
  }

  async function settle() {
    await rt.onAgentSettled({ type: "agent_settled" }, ctx);
  }

  async function planFile() {
    const files = (await import("node:fs/promises")).readdir(cwd);
    for (const name of await files) {
      if (name.startsWith("plan_") && name.endsWith(".md")) return readFile(join(cwd, name), "utf-8");
    }
    return "";
  }

  async function cleanup() {
    // Para el runtime: sin esto, los timers de animación/highlight mantienen vivo
    // el event loop y node --test cuelga al final.
    try {
      await rt.onSessionShutdown({ type: "session_shutdown" }, ctx);
    } catch {
      // ya parado
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    process.env.HOME = prevHome;
  }

  return { rt, ctx, pi, entries, notes, widgets, cwd, tool, addTasks, plan, statusByRef, runStart, toolResult, turnEnd, settle, planFile, cleanup };
}
