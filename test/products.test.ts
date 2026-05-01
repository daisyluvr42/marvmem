import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMarvMem } from "../src/core/memory.js";
import { MarvMemPlatformService } from "../src/platform/service.js";
import { MarvMemCodingService } from "../src/products/coding/service.js";
import { MarvMemRuntimeService } from "../src/products/runtime/service.js";
import { extractCodingProposals } from "../src/products/coding/extraction.js";
import type { MemoryContext } from "../src/platform/types.js";

function makeContext(overrides?: Partial<MemoryContext>): MemoryContext {
  return {
    projectId: "proj_products_test",
    repoId: "repo_products_test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Coding extraction
// ---------------------------------------------------------------------------

describe("extractCodingProposals", () => {
  it("extracts repo convention from 'this repo uses' pattern", () => {
    const proposals = extractCodingProposals({
      userMessage: "This repo uses ESM only for module resolution.",
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.kind, "repo_convention");
  });

  it("extracts workflow rule from 'run tests' pattern", () => {
    const proposals = extractCodingProposals({
      userMessage: "Always run tests with npm test --coverage.",
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.kind, "workflow_rule");
  });

  it("returns empty for unrelated message", () => {
    const proposals = extractCodingProposals({
      userMessage: "What is the capital of France?",
    });
    assert.equal(proposals.length, 0);
  });

  it("extracts repo convention from Chinese content", () => {
    const proposals = extractCodingProposals({
      userMessage: "这个仓库用TypeScript",
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.kind, "repo_convention");
  });
});

// ---------------------------------------------------------------------------
// CodingMemoryService
// ---------------------------------------------------------------------------

describe("MarvMemCodingService", () => {
  let service: MarvMemCodingService;

  beforeEach(() => {
    const memory = createMarvMem({ storage: { backend: "memory" } });
    const platform = new MarvMemPlatformService({ memory });
    service = new MarvMemCodingService({ platform });
  });

  it("captureCodingTurn captures a turn", async () => {
    const result = await service.captureCodingTurn({
      context: makeContext(),
      userMessage: "Remember this repo uses pnpm.",
      assistantMessage: "Noted.",
    });
    assert.ok(result.proposals !== undefined);
    assert.ok(Array.isArray(result.stored));
  });

  it("buildCodingRecall returns context", async () => {
    await service.captureCodingTurn({
      context: makeContext(),
      userMessage: "This repo uses TypeScript with strict mode.",
    });
    const recall = await service.buildCodingRecall({
      context: makeContext(),
      message: "What language settings?",
    });
    assert.ok(typeof recall.injectedContext === "string");
  });

  it("listRepoMemories defaults to repo + project scopes", async () => {
    const memories = await service.listRepoMemories({
      context: makeContext(),
    });
    assert.ok(Array.isArray(memories));
  });
});

// ---------------------------------------------------------------------------
// RuntimeMemoryService
// ---------------------------------------------------------------------------

describe("MarvMemRuntimeService", () => {
  let service: MarvMemRuntimeService;

  beforeEach(() => {
    const memory = createMarvMem({ storage: { backend: "memory" } });
    const platform = new MarvMemPlatformService({ memory });
    service = new MarvMemRuntimeService({ platform });
  });

  it("beforePrompt returns recall context", async () => {
    const result = await service.beforePrompt({
      context: makeContext(),
      message: "How do I do X?",
    });
    assert.ok(typeof result.injectedContext === "string");
  });

  it("afterTurn captures a turn", async () => {
    const result = await service.afterTurn({
      context: makeContext(),
      userMessage: "Do X.",
      assistantMessage: "Done.",
    });
    assert.ok(result.proposals !== undefined);
  });

  it("captureRuntimeReflection writes experience memory", async () => {
    const record = await service.captureRuntimeReflection({
      context: makeContext(),
      summary: "User prefers concise answers.",
    });
    assert.ok(record);
    assert.equal(record.kind, "experience");
    assert.ok(record.content.includes("concise"));
  });

  it("captureRuntimeReflection returns null for empty summary", async () => {
    const record = await service.captureRuntimeReflection({
      context: makeContext(),
      summary: "   ",
    });
    assert.equal(record, null);
  });

  it("syncRuntimeMemory fails without bridge", async () => {
    const result = await service.syncRuntimeMemory({
      bridge: { context: makeContext() },
      direction: "import",
    });
    assert.equal(result.success, false);
    assert.ok(result.errors?.[0]?.includes("No bridge"));
  });
});
