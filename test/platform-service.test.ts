import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMarvMem } from "../src/core/memory.js";
import { MarvMemPlatformService } from "../src/platform/service.js";
import { InMemoryInspectEventStore } from "../src/inspect/store.js";
import { DispatchingInspectEventStore, WebhookDispatcher } from "../src/inspect/webhook.js";
import type { MemoryContext } from "../src/platform/types.js";

function makeContext(overrides?: Partial<MemoryContext>): MemoryContext {
  return {
    projectId: "proj_test",
    repoId: "repo_test",
    userId: "user_test",
    agentId: "test_agent",
    ...overrides,
  };
}

describe("MarvMemPlatformService", () => {
  let service: MarvMemPlatformService;
  let events: InMemoryInspectEventStore;

  beforeEach(() => {
    const memory = createMarvMem({ storage: { backend: "memory" } });
    events = new InMemoryInspectEventStore();
    service = new MarvMemPlatformService({ memory, events });
  });

  // -----------------------------------------------------------------------
  // writeMemory
  // -----------------------------------------------------------------------

  describe("writeMemory", () => {
    it("writes a memory and returns the record", async () => {
      const record = await service.writeMemory({
        context: makeContext(),
        kind: "repo_convention",
        content: "Use pnpm workspaces.",
      });
      assert.ok(record.id);
      assert.equal(record.kind, "repo_convention");
      assert.equal(record.content, "Use pnpm workspaces.");
      assert.equal(record.scope.type, "repo");
      assert.equal(record.scope.id, "proj_test::repo_test");
    });

    it("uses project scope when repoId is absent", async () => {
      const record = await service.writeMemory({
        context: makeContext({ repoId: undefined }),
        kind: "fact",
        content: "A fact.",
      });
      assert.equal(record.scope.type, "project");
      assert.equal(record.scope.id, "proj_test");
    });

    it("emits a memory_written event", async () => {
      await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "Something.",
      });
      const recent = events.recent({ type: "memory_written" });
      assert.equal(recent.length, 1);
      assert.equal(recent[0]!.data!["kind"], "fact");
    });
  });

  // -----------------------------------------------------------------------
  // listMemories
  // -----------------------------------------------------------------------

  describe("listMemories", () => {
    it("lists memories matching the context scopes", async () => {
      await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "Fact one.",
      });
      await service.writeMemory({
        context: makeContext(),
        kind: "preference",
        content: "Prefer dark mode.",
      });

      const all = await service.listMemories({ context: makeContext() });
      assert.equal(all.length, 2);
    });

    it("does not leak same repoId across projects", async () => {
      await service.writeMemory({
        context: makeContext({ projectId: "proj_a", repoId: "shared" }),
        kind: "fact",
        content: "Project A secret.",
      });

      const leaked = await service.listMemories({
        context: makeContext({ projectId: "proj_b", repoId: "shared" }),
      });
      assert.equal(leaked.length, 0);
    });

    it("filters by kind", async () => {
      await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "Fact.",
      });
      await service.writeMemory({
        context: makeContext(),
        kind: "preference",
        content: "Pref.",
      });

      const facts = await service.listMemories({
        context: makeContext(),
        kinds: ["fact"],
      });
      assert.equal(facts.length, 1);
      assert.equal(facts[0]!.kind, "fact");
    });

    it("respects limit", async () => {
      const distinctContents = [
        "TypeScript is the primary language.",
        "We use PostgreSQL for persistence.",
        "Authentication is handled via JWT.",
        "CI runs in GitHub Actions.",
        "Deployment targets Kubernetes.",
      ];
      for (const [index, content] of distinctContents.entries()) {
        await service.writeMemory({
          context: makeContext(),
          kind: `fact_${index}`,
          content,
        });
      }
      const limited = await service.listMemories({
        context: makeContext(),
        limit: 3,
      });
      assert.equal(limited.length, 3);
    });

    it("applies cursor before limit", async () => {
      const distinctContents = [
        "Fact alpha.",
        "Fact beta.",
        "Fact gamma.",
        "Fact delta.",
        "Fact epsilon.",
      ];
      for (const [index, content] of distinctContents.entries()) {
        await service.writeMemory({
          context: makeContext(),
          kind: `cursor_fact_${index}`,
          content,
        });
      }

      const full = await service.listMemories({ context: makeContext() });
      const page1 = await service.listMemories({
        context: makeContext(),
        limit: 2,
      });
      const page2 = await service.listMemories({
        context: makeContext(),
        limit: 2,
        cursor: page1[1]!.id,
      });

      assert.deepEqual(
        page1.map((record) => record.id),
        full.slice(0, 2).map((record) => record.id),
      );
      assert.deepEqual(
        page2.map((record) => record.id),
        full.slice(2, 4).map((record) => record.id),
      );
    });
  });

  // -----------------------------------------------------------------------
  // getMemory + project isolation
  // -----------------------------------------------------------------------

  describe("getMemory", () => {
    it("returns a record in the same project", async () => {
      const written = await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "A fact.",
      });
      const found = await service.getMemory({
        context: makeContext(),
        id: written.id,
      });
      assert.ok(found);
      assert.equal(found.id, written.id);
    });

    it("returns null for a different project (isolation)", async () => {
      const written = await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "A fact.",
      });
      const found = await service.getMemory({
        context: makeContext({ projectId: "proj_other", repoId: "repo_other" }),
        id: written.id,
      });
      assert.equal(found, null);
    });

    it("returns null for non-existent id", async () => {
      const found = await service.getMemory({
        context: makeContext(),
        id: "nonexistent",
      });
      assert.equal(found, null);
    });
  });

  // -----------------------------------------------------------------------
  // updateMemory
  // -----------------------------------------------------------------------

  describe("updateMemory", () => {
    it("updates content and emits event", async () => {
      const written = await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "Old content.",
      });
      const updated = await service.updateMemory({
        ref: { context: makeContext(), id: written.id },
        patch: { content: "New content." },
      });
      assert.ok(updated);
      assert.equal(updated.content, "New content.");

      const updateEvents = events.recent({ type: "memory_updated" });
      assert.equal(updateEvents.length, 1);
    });

    it("returns null for cross-project update (isolation)", async () => {
      const written = await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "A fact.",
      });
      const result = await service.updateMemory({
        ref: { context: makeContext({ projectId: "proj_other", repoId: "repo_other" }), id: written.id },
        patch: { content: "Hacked!" },
      });
      assert.equal(result, null);
    });
  });

  // -----------------------------------------------------------------------
  // deleteMemory
  // -----------------------------------------------------------------------

  describe("deleteMemory", () => {
    it("deletes a record and emits event", async () => {
      const written = await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "To delete.",
      });
      const deleted = await service.deleteMemory({
        context: makeContext(),
        id: written.id,
      });
      assert.ok(deleted);

      const deleteEvents = events.recent({ type: "memory_deleted" });
      assert.equal(deleteEvents.length, 1);

      const found = await service.getMemory({
        context: makeContext(),
        id: written.id,
      });
      assert.equal(found, null);
    });

    it("returns false for cross-project delete (isolation)", async () => {
      const written = await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "A fact.",
      });
      const deleted = await service.deleteMemory({
        context: makeContext({ projectId: "proj_other", repoId: "repo_other" }),
        id: written.id,
      });
      assert.equal(deleted, false);
    });
  });

  // -----------------------------------------------------------------------
  // buildRecall / inspectRecall
  // -----------------------------------------------------------------------

  describe("buildRecall", () => {
    it("returns a recall result with injectedContext", async () => {
      await service.writeMemory({
        context: makeContext(),
        kind: "repo_convention",
        content: "This repo uses pnpm workspaces for monorepo management.",
      });

      const result = await service.buildRecall({
        context: makeContext(),
        message: "How do I manage packages in this repo?",
      });

      assert.ok(typeof result.injectedContext === "string");
      assert.ok(result.hits !== undefined);

      const recallEvents = events.recent({ type: "recall_built" });
      assert.equal(recallEvents.length, 1);
    });
  });

  describe("inspectRecall", () => {
    it("returns a RecallInspection with layers", async () => {
      await service.writeMemory({
        context: makeContext(),
        kind: "fact",
        content: "TypeScript is the primary language.",
      });

      const inspection = await service.inspectRecall({
        context: makeContext(),
        message: "What language do we use?",
      });

      assert.equal(inspection.context.projectId, "proj_test");
      assert.equal(inspection.message, "What language do we use?");
      assert.ok(typeof inspection.injectedContext === "string");
      assert.ok(inspection.layers !== undefined);
    });
  });

  // -----------------------------------------------------------------------
  // captureTurn
  // -----------------------------------------------------------------------

  describe("captureTurn", () => {
    it("captures a turn and returns proposals", async () => {
      const result = await service.captureTurn({
        context: makeContext(),
        userMessage: "Remember that we use ESM modules only.",
        assistantMessage: "Got it, ESM only.",
      });

      assert.ok(result.proposals !== undefined);
      assert.ok(Array.isArray(result.stored));
    });

    it("stores durable preferences on the user scope instead of the task scope", async () => {
      const result = await service.captureTurn({
        context: makeContext({ taskId: "reply_style" }),
        userMessage: "Remember that I prefer concise replies.",
      });

      const preference = result.stored.find((record) => record.kind === "preference");
      const explicitRemember = result.stored.find((record) => record.kind === "fact");

      assert.ok(preference);
      assert.equal(preference.scope.type, "user");
      assert.equal(preference.scope.id, "user_test");

      assert.ok(explicitRemember);
      assert.equal(explicitRemember.scope.type, "repo");
      assert.equal(explicitRemember.scope.id, "proj_test::repo_test");

      assert.equal(result.stored.some((record) => record.scope.type === "task"), false);
    });
  });
});

// ---------------------------------------------------------------------------

describe("DispatchingInspectEventStore", () => {
  it("dispatches emitted events to webhooks", () => {
    const received: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      received.push({ url: String(url), body: init?.body });
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    try {
      const store = new DispatchingInspectEventStore(
        new InMemoryInspectEventStore(),
        new WebhookDispatcher([{ url: "https://example.test/hook", events: ["memory_written"] }]),
      );
      store.emit({ type: "memory_written", context: { projectId: "p1" } });
      assert.equal(received.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
// InMemoryInspectEventStore
// ---------------------------------------------------------------------------

describe("InMemoryInspectEventStore", () => {
  it("emits and retrieves events", () => {
    const store = new InMemoryInspectEventStore();
    store.emit({
      type: "memory_written",
      context: { projectId: "p1" },
      data: { recordId: "r1" },
    });
    store.emit({
      type: "recall_built",
      context: { projectId: "p1" },
      data: { query: "test" },
    });

    const all = store.recent();
    assert.equal(all.length, 2);
    // newest first
    assert.equal(all[0]!.type, "recall_built");
    assert.equal(all[1]!.type, "memory_written");
  });

  it("filters by event type", () => {
    const store = new InMemoryInspectEventStore();
    store.emit({ type: "memory_written", context: { projectId: "p1" } });
    store.emit({ type: "recall_built", context: { projectId: "p1" } });
    store.emit({ type: "memory_written", context: { projectId: "p1" } });

    const writes = store.recent({ type: "memory_written" });
    assert.equal(writes.length, 2);
  });

  it("respects capacity limit", () => {
    const store = new InMemoryInspectEventStore(3);
    for (let i = 0; i < 5; i++) {
      store.emit({ type: "memory_written", context: { projectId: "p1" }, data: { i } });
    }
    const all = store.recent();
    assert.equal(all.length, 3);
    // newest should be i=4
    assert.equal(all[0]!.data!["i"], 4);
  });

  it("clears all events", () => {
    const store = new InMemoryInspectEventStore();
    store.emit({ type: "memory_written", context: { projectId: "p1" } });
    store.clear();
    assert.equal(store.recent().length, 0);
  });
});
