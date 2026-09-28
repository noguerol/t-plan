/**
 * Regression: extension-injected prompts must NOT seed spec memory.
 *
 * The critique extension injects its autocritique directive via
 * pi.sendUserMessage(..., { deliverAs: 'followUp' }); pi surfaces it as an
 * `input` event with source 'extension' BEFORE the corresponding
 * `before_agent_start`. Since BeforeAgentStartEvent carries no source field,
 * the runtime records the input-event source and skips
 * looksLikeComplexSpec/ingestSpec/ingestReferencedFiles for those prompts.
 *
 * This test proves: (a) an injected complex prompt seeds nothing, (b) a real
 * interactive spec prompt still seeds, (c) the flag resets correctly across
 * mixed orderings and missing input events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePeers } from "./helpers/ensure-peers.mjs";
import { createHarness } from "./helpers/harness.mjs";

await ensurePeers();

// Structured enough to trip looksLikeComplexSpec (same shape as the real
// autocritique directive: headings + MUST/SHOULD bullets).
const INJECTED_SPEC = `# Autocritique Directive

## Review
- The agent MUST critique the last answer for correctness gaps.
- Must check every claim against the files it read.
- Must flag any unverified assertion explicitly.

## Reporting
- The agent MUST list the strongest counterargument first.
- Must end with a single verdict: keep or revise.
- Must keep the critique under 200 words.`;

const input = (h, source) => h.rt.onInput({ prompt: INJECTED_SPEC, source }, h.ctx);
const agentStart = (h, prompt = INJECTED_SPEC) =>
  h.rt.onBeforeAgentStart({ prompt, systemPrompt: "" }, h.ctx);

test("extension-injected complex prompt seeds no requirements or tasks", async () => {
  const h = await createHarness({ sessionId: "extinj001" });
  try {
    await input(h, "extension");
    await agentStart(h);

    const state = h.rt.getState();
    assert.equal(state.specs, undefined, "no spec source may be registered");
    assert.equal(state.requirements?.length ?? 0, 0, "no requirements may be seeded");
    assert.equal(state.tasks.length, 0, "no tasks may be seeded");
    assert.equal(await h.planFile(), "", "the plan file must not be created");
  } finally {
    await h.cleanup();
  }
});

test("extension-injected prompt with a referenced spec file ingests nothing", async () => {
  const h = await createHarness({ sessionId: "extinj002" });
  try {
    await writeFile(
      join(h.cwd, "spec.md"),
      "# Spec\n## API\n- The system MUST expose GET /health for the load balancer.\n- Must reject malformed requests with 400.\n",
      "utf-8"
    );
    await input(h, "extension");
    await agentStart(h, `Critique the last answer. See spec.md for context.`);

    const state = h.rt.getState();
    assert.equal(state.specs, undefined, "the referenced file must not be ingested");
    assert.equal(state.requirements?.length ?? 0, 0);
    assert.equal(state.tasks.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("interactive complex prompt still seeds requirements and tasks", async () => {
  const h = await createHarness({ sessionId: "extinj003" });
  try {
    await input(h, "interactive");
    await agentStart(h);

    const state = h.rt.getState();
    assert.equal(state.specs?.length, 1, "the interactive spec must be registered");
    assert.ok((state.requirements?.length ?? 0) >= 5, "requirements must be seeded");
    assert.equal(state.tasks.length, 5, "requirements are tasked only up to the active window");
  } finally {
    await h.cleanup();
  }
});

test("rpc complex prompt still seeds (non-interactive but user-originated)", async () => {
  const h = await createHarness({ sessionId: "extinj004" });
  try {
    await input(h, "rpc");
    await agentStart(h);
    assert.ok((h.rt.getState().requirements?.length ?? 0) >= 5, "rpc prompts must still ingest");
  } finally {
    await h.cleanup();
  }
});

test("a real user spec after an injected prompt is still ingested", async () => {
  const h = await createHarness({ sessionId: "extinj005" });
  try {
    // Turn 1: extension-injected directive — must be skipped.
    await input(h, "extension");
    await agentStart(h);
    assert.equal(h.rt.getState().tasks.length, 0, "injected turn must seed nothing");

    // Turn 2: genuine user spec — the flag must have been reset.
    await input(h, "interactive");
    await agentStart(h);
    const state = h.rt.getState();
    assert.equal(state.specs?.length, 1, "the user spec must be ingested after the injection");
    assert.ok(state.requirements.length >= 5, "the user spec must seed requirements");
  } finally {
    await h.cleanup();
  }
});

test("no stale flag: before_agent_start without a preceding input event still ingests", async () => {
  const h = await createHarness({ sessionId: "extinj006" });
  try {
    // Edge ordering: the input event never fired (e.g. harness/older pi).
    // The flag must default to "not injected" so real specs are never lost.
    await agentStart(h);
    assert.ok((h.rt.getState().requirements?.length ?? 0) >= 5, "must ingest without an input event");
  } finally {
    await h.cleanup();
  }
});

test("an unknown input source neither poisons nor clears a pending mark", async () => {
  const h = await createHarness({ sessionId: "extinj007" });
  try {
    await input(h, "extension");
    await input(h, "weird-source");
    await agentStart(h);
    assert.equal(h.rt.getState().tasks.length, 0, "the extension mark must survive an unknown source");

    // Once consumed, the next before_agent_start (no new input event) must
    // ingest again: the mark must not linger into a later turn.
    await agentStart(h);
    assert.ok((h.rt.getState().requirements?.length ?? 0) >= 5, "the consumed flag must not poison the next turn");
  } finally {
    await h.cleanup();
  }
});
