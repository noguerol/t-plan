/**
 * Unit coverage for src/spec.ts — the pure half of the spec-driven memory.
 * No harness needed: these functions never touch the filesystem or the runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensurePeers } from "./helpers/ensure-peers.mjs";

await ensurePeers();

const {
  SPEC_ACTIVE_WINDOW,
  MAX_REQUIREMENTS,
  MAX_PROJECT_REQUIREMENTS,
  MAX_SPEC_SOURCES,
  hashText,
  looksLikeComplexSpec,
  extractRequirements,
  isSpecDocument,
  isNormativeBullet,
  requirementTitle,
  requirementSignature,
  makeSpecSource,
  nextSpecId,
  nextRequirementId,
  computeCoverage,
  formatCoverageContext,
  defaultChecksFor,
  taskVerificationRequired,
  taskVerified,
  parseReqs,
  parseChecks,
} = await import("../src/spec.ts");

test("hashText is deterministic, non-empty and input-sensitive", () => {
  assert.equal(hashText("hello world"), hashText("hello world"));
  assert.notEqual(hashText("hello world"), hashText("hello worlds"));
  assert.ok(hashText("").length > 0, "empty input still yields a stable token");
  assert.ok(hashText("x").length > 0);
});

test("looksLikeComplexSpec separates specs from chatter", () => {
  assert.equal(looksLikeComplexSpec("fix the typo"), false);
  assert.equal(looksLikeComplexSpec(""), false);
  assert.equal(looksLikeComplexSpec("The system MUST authenticate users."), true);
  assert.equal(looksLikeComplexSpec("Requisitos: la app debe permitir login"), true);
  assert.equal(looksLikeComplexSpec("Implement RF-3 with tests"), true);
  // Structure alone is not a spec: a notes checklist must not qualify (RC-3).
  const long = Array.from({ length: 10 }, (_, i) => `- item number ${i}`).join("\n");
  assert.equal(looksLikeComplexSpec(long), false);
  const normative = Array.from({ length: 10 }, (_, i) => `- Requirement ${i} MUST work.`).join("\n");
  assert.equal(looksLikeComplexSpec(normative), true);
});

test("isSpecDocument accepts declared specs and refuses project docs (F-2)", () => {
  assert.equal(isSpecDocument("docs/app-spec.md", "# App\n## Requirements\n- MUST auth"), true);
  assert.equal(isSpecDocument("docs/requirements.md", "plain notes"), true);
  assert.equal(isSpecDocument("checkout.prd.md", "plain"), true);
  assert.equal(isSpecDocument("notes.md", "The system MUST satisfy RF-12."), true);
  assert.equal(isSpecDocument("notes.md", "# X\n## Acceptance criteria\n- MUST pass"), true);
  // Denylist: project memory, plans, changelogs, ADRs and testing notes.
  assert.equal(isSpecDocument("pi.md", "# Memory\n- MUST not commit this file"), false);
  assert.equal(isSpecDocument("plan_app.md", "# Plan\n- MUST do x"), false);
  assert.equal(isSpecDocument("CHANGELOG.md", "# Changelog\n- Must fix"), false);
  assert.equal(isSpecDocument("CONTRIBUTING.md", "- MUST run tests"), false);
  assert.equal(isSpecDocument("docs/adr/0001-db.md", "# ADR\n## Requirements\n- MUST use pg"), false);
  assert.equal(isSpecDocument("docs/testing/audit/findings.md", "- MUST check"), false);
});

test("project-memory notes yield zero requirements (F-3 bad-source rejection)", () => {
  const memory = `# Continuation Brief

Purpose: everything a new session needs to pick this up

## Files touched
- packages/core/src/run-service.ts
- packages/web/src/NewNodeDialog.tsx

## Recent work
- Why: Continuando con "cablear las vistas por kind", encontré un arreglo
- 281 tests, 14/14 build+typecheck, guards OK.
- id: 01a0c64a-46c
`;
  assert.deepEqual(extractRequirements(memory, "S1"), []);
  const changelog = "# Changelog\n\n## 1.7.0\n- Added spec memory.\n- Fixed a crash.\n";
  assert.deepEqual(extractRequirements(changelog, "S1"), []);
  const adr = "# 0001. Use Postgres\n\n## Decision\nWe will use Postgres.\n\n## Consequences\nMigrations follow.\n";
  assert.deepEqual(extractRequirements(adr, "S1"), []);
});

test("only normative bullets are requirements (F-3)", () => {
  assert.equal(isNormativeBullet("packages/core/src/run-service.ts"), false);
  assert.equal(isNormativeBullet("id: 01a0c64a-46c"), false);
  assert.equal(isNormativeBullet("281 tests, 14/14 build+typecheck"), false);
  assert.equal(isNormativeBullet("Why: we changed the parser"), false);
  assert.equal(isNormativeBullet("The system MUST authenticate users."), true);
  assert.equal(isNormativeBullet("Expose GET /health."), true);
  assert.equal(isNormativeBullet("Use OAuth (RFC 6749).", "Requirements"), true);
  assert.equal(isNormativeBullet("anything at all", "Acceptance criteria"), true);
});

test("requirementTitle derives a short clause and keeps the excerpt separate", () => {
  assert.equal(requirementTitle("Implement OAuth login."), "Implement OAuth login");
  const long = "Must persist user sessions in Postgres for 30 days and then expire them cleanly after the window closes.";
  const title = requirementTitle(long);
  assert.ok(title.length <= 80, `title too long: ${title.length}`);
  assert.ok(long.startsWith(title.replace(/…$/, "").trimEnd()), "title must be the first clause");
  assert.deepEqual(MAX_SPEC_SOURCES > 0, true);
  assert.deepEqual(MAX_PROJECT_REQUIREMENTS > MAX_REQUIREMENTS, true);
});

test("extractRequirements captures bullets/numbered items with section anchors and dedupes", () => {
  const spec = `# App

## Auth
- The system MUST authenticate users via OAuth2.
- The system MUST authenticate users via OAuth2.
- Must persist sessions in Postgres.

## API
1. Expose GET /health.
2. Expose POST /login validating credentials.
`;
  const reqs = extractRequirements(spec, "S1");
  assert.ok(reqs.length >= 3, `expected >=3 requirements, got ${reqs.length}`);
  assert.ok(reqs.every((r) => r.sourceId === "S1"));
  assert.ok(reqs.some((r) => r.anchor === "Auth"));
  assert.ok(reqs.some((r) => r.anchor === "API"));
  const texts = reqs.map((r) => r.text.toLowerCase());
  assert.equal(texts.filter((t) => t.includes("oauth2")).length, 1, "near-duplicate lines must be deduped");
});

test("extractRequirements is tolerant: empty and garbage never throw", () => {
  assert.deepEqual(extractRequirements("", "S1"), []);
  assert.deepEqual(extractRequirements("   \n\n  \t", "S1"), []);
  assert.deepEqual(extractRequirements("!!! ### ---", "S1"), []);
});

test("extractRequirements caps the number of requirements", () => {
  const huge = Array.from({ length: MAX_REQUIREMENTS + 50 }, (_, i) => `- Requirement number ${i} MUST work.`).join("\n");
  assert.ok(extractRequirements(huge, "S1").length <= MAX_REQUIREMENTS);
});

test("requirementSignature is case/diacritic-insensitive", () => {
  assert.equal(requirementSignature("Autenticación de Usuarios"), requirementSignature("autenticacion de usuarios"));
  assert.equal(requirementSignature("Auth users!"), requirementSignature("auth   users"));
  assert.notEqual(requirementSignature("alpha"), requirementSignature("beta"));
});

test("nextSpecId / nextRequirementId skip non-matching ids", () => {
  assert.equal(nextSpecId([]), "S1");
  assert.equal(nextSpecId([{ id: "S1" }, { id: "S7" }, { id: "R2" }]), "S8");
  assert.equal(nextRequirementId([]), "R1");
  assert.equal(nextRequirementId([{ id: "R3" }, { id: "S9" }]), "R4");
});

test("computeCoverage reports mapped/satisfied/percent and the empty case", () => {
  const reqs = [
    { id: "R1", sourceId: "S1", text: "a" },
    { id: "R2", sourceId: "S1", text: "b" },
    { id: "R3", sourceId: "S1", text: "c" },
  ];
  const tasks = [
    { id: "t1", ref: 1, text: "a", status: "done", order: 1, reqs: ["R1"] },
    { id: "t2", ref: 2, text: "b", status: "pending", order: 2, reqs: ["R2"] },
  ];
  const cov = computeCoverage(reqs, tasks);
  assert.equal(cov.total, 3);
  assert.equal(cov.mapped, 2);
  assert.equal(cov.satisfied, 1);
  assert.equal(cov.percent, 33);
  assert.deepEqual(cov.unmapped.map((r) => r.id), ["R3"]);
  assert.deepEqual(cov.unsatisfied.map((r) => r.id), ["R2", "R3"]);

  const empty = computeCoverage([], tasks);
  assert.equal(empty.total, 0);
  assert.equal(empty.percent, 100);
  assert.deepEqual(formatCoverageContext([], tasks), "");
});

test("formatCoverageContext lists gaps and hides at 100%", () => {
  const reqs = [
    { id: "R1", sourceId: "S1", anchor: "Auth", text: "a" },
    { id: "R2", sourceId: "S1", anchor: "API", text: "b" },
  ];
  const tasks = [{ id: "t1", ref: 1, text: "a", status: "done", order: 1, reqs: ["R1"] }];
  const block = formatCoverageContext(reqs, tasks);
  assert.ok(block.startsWith("[SPEC]"));
  assert.match(block, /1\/2 satisfied/);
  assert.match(block, /R2 API/);
  const full = formatCoverageContext(reqs, [
    { id: "t1", ref: 1, text: "a", status: "done", order: 1, reqs: ["R1"] },
    { id: "t2", ref: 2, text: "b", status: "done", order: 2, reqs: ["R2"] },
  ]);
  assert.ok(!full.includes("gaps:"), "no gaps line when everything is satisfied");
});

test("defaultChecksFor requires build/tests for code work", () => {
  assert.deepEqual(defaultChecksFor("Implement the login endpoint"), [
    "compiles/typechecks",
    "tests pass",
    "behavior matches the spec excerpt",
  ]);
  assert.deepEqual(defaultChecksFor("The brand guidelines are respected"), ["matches the spec excerpt"]);
});

test("taskVerificationRequired / taskVerified", () => {
  const plain = { id: "t", ref: 1, text: "x", status: "pending", order: 1 };
  assert.equal(taskVerificationRequired(plain), false);
  assert.equal(taskVerified(plain, 0), true, "non-spec tasks need no verification");

  const spec = { ...plain, spec: "do x", check: ["tests pass"] };
  assert.equal(taskVerificationRequired(spec), true);
  assert.equal(taskVerified(spec, 0), false);
  assert.equal(taskVerified(spec, 1), true, "a test/build run verifies it");
  assert.equal(taskVerified({ ...spec, verifiedAt: 123 }, 0), true, "explicit verify wins");
});

test("parseReqs / parseChecks normalize tool params", () => {
  assert.deepEqual(parseReqs("R2, R5"), ["R2", "R5"]);
  assert.deepEqual(parseReqs("r1;R2 R2"), ["R1", "R2"]);
  assert.deepEqual(parseReqs(""), []);
  assert.deepEqual(parseReqs("not-a-req"), []);
  assert.deepEqual(parseChecks("compiles | tests pass; matches spec"), ["compiles", "tests pass", "matches spec"]);
  assert.deepEqual(parseChecks(undefined), []);
});

test("makeSpecSource records a title, hash and requirement count", () => {
  const s = makeSpecSource("S1", "file", "docs/app.md", "# App Spec\n- MUST do x", 1);
  assert.equal(s.id, "S1");
  assert.equal(s.kind, "file");
  assert.equal(s.ref, "docs/app.md");
  assert.equal(s.title, "App Spec");
  assert.equal(s.requirementCount, 1);
  assert.ok(s.hash.length > 0);
  assert.ok(SPEC_ACTIVE_WINDOW > 0);
});
