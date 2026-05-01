import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createMarvMem } from "../src/core/memory.js";
import { HermesBridgeAdapter } from "../src/bridge/hermes.js";
import { OpenClawBridgeAdapter } from "../src/bridge/openclaw.js";
import { createBridgeRegistry } from "../src/bridge/base.js";
import { classifyRecord, summarizeRecordForProjection } from "../src/bridge/policy.js";
import { canonicalRepoId } from "../src/platform/context.js";
import type { MemoryContext } from "../src/platform/types.js";

const FIXTURE_DIR = join(import.meta.dirname ?? ".", ".bridge-test-fixtures");

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function cleanup() {
  try {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  } catch {}
}

function makeContext(): MemoryContext {
  return { projectId: "proj_bridge_test", repoId: "repo_bridge" };
}

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

describe("bridge/policy", () => {
  it("classifyRecord returns metadata target when matching", () => {
    const record = {
      id: "r1",
      scope: { type: "repo" as const, id: "r" },
      kind: "note",
      content: "test",
      summary: "test",
      confidence: 1,
      importance: 1,
      source: "test",
      tags: [],
      metadata: { projectionTarget: "user" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = classifyRecord(record, [{ target: "user", matchKinds: ["preference"] }]);
    assert.equal(result, "user");
  });

  it("classifyRecord matches by kind", () => {
    const record = {
      id: "r1",
      scope: { type: "repo" as const, id: "r" },
      kind: "preference",
      content: "test",
      summary: "test",
      confidence: 1,
      importance: 1,
      source: "test",
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = classifyRecord(record, [{ target: "user", matchKinds: ["preference"] }]);
    assert.equal(result, "user");
  });

  it("classifyRecord falls back to default", () => {
    const record = {
      id: "r1",
      scope: { type: "repo" as const, id: "r" },
      kind: "note",
      content: "test",
      summary: "test",
      confidence: 1,
      importance: 1,
      source: "test",
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const result = classifyRecord(record, [{ target: "user", matchKinds: ["preference"] }]);
    assert.equal(result, "memory");
  });

  it("summarizeRecordForProjection prefers summary", () => {
    const record = {
      id: "r1",
      scope: { type: "repo" as const, id: "r" },
      kind: "note",
      content: "full content",
      summary: "short summary",
      confidence: 1,
      importance: 1,
      source: "test",
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.equal(summarizeRecordForProjection(record), "short summary");
  });
});

// ---------------------------------------------------------------------------
// Hermes bridge
// ---------------------------------------------------------------------------

describe("HermesBridgeAdapter", () => {
  let memory: ReturnType<typeof createMarvMem>;

  beforeEach(() => {
    cleanup();
    memory = createMarvMem({ storage: { backend: "memory" } });
  });

  it("imports MEMORY.md and USER.md entries", async () => {
    const memDir = join(FIXTURE_DIR, "hermes");
    ensureDir(memDir);
    writeFileSync(join(memDir, "MEMORY.md"), "- Hermes fact one\n- Hermes fact two\n");
    writeFileSync(join(memDir, "USER.md"), "- User pref one\n");

    const adapter = new HermesBridgeAdapter({
      memory,
      files: {
        memoryPath: join(memDir, "MEMORY.md"),
        userPath: join(memDir, "USER.md"),
      },
    });

    const result = await adapter.import({
      bridge: { context: makeContext() },
    });

    assert.equal(result.success, true);
    assert.equal(result.imported, 3);
    cleanup();
  });

  it("exports records back to markdown files", async () => {
    const memDir = join(FIXTURE_DIR, "hermes-export");
    ensureDir(memDir);

    const adapter = new HermesBridgeAdapter({
      memory,
      files: {
        memoryPath: join(memDir, "MEMORY.md"),
        userPath: join(memDir, "USER.md"),
      },
    });

    // Write some records first
    const ctx = makeContext();
    await memory.remember({
      scope: { type: "repo", id: canonicalRepoId(ctx)! },
      kind: "note",
      content: "A memory note",
      summary: "A memory note",
      source: "test",
      tags: ["hermes", "memory"],
      metadata: { projectionTarget: "memory" },
    });

    const result = await adapter.export({
      bridge: { context: ctx },
    });

    assert.equal(result.success, true);
    assert.ok(result.exported > 0);
    assert.ok(existsSync(join(memDir, "MEMORY.md")));
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Bridge registry
// ---------------------------------------------------------------------------

describe("createBridgeRegistry", () => {
  it("creates a registry from adapters", () => {
    const memory = createMarvMem({ storage: { backend: "memory" } });
    const hermes = new HermesBridgeAdapter({ memory });
    const openclaw = new OpenClawBridgeAdapter({ memory });
    const registry = createBridgeRegistry([hermes, openclaw]);

    assert.equal(registry.size, 2);
    assert.equal(registry.get("hermes")?.name, "hermes");
    assert.equal(registry.get("openclaw")?.name, "openclaw");
    assert.equal(registry.get("unknown"), undefined);
  });
});
