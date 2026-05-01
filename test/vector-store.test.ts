import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryVectorStore } from "../src/retrieval/vector-memory.js";
import { RetrievalManager } from "../src/retrieval/manager.js";
import { buildEmbeddingText } from "../src/retrieval/vector-store.js";
import type { MemoryRecord } from "../src/core/types.js";

describe("InMemoryVectorStore", () => {
  it("upserts and searches documents", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: "d1", vector: [1, 0, 0], content: "TypeScript is great" },
      { id: "d2", vector: [0, 1, 0], content: "Python is versatile" },
      { id: "d3", vector: [0.9, 0.1, 0], content: "TS is a typed language" },
    ]);

    const results = await store.search([1, 0, 0], { topK: 2 });
    assert.equal(results.length, 2);
    assert.equal(results[0]!.id, "d1");
    assert.ok(results[0]!.score > results[1]!.score);
  });

  it("respects minScore filter", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: "d1", vector: [1, 0, 0], content: "A" },
      { id: "d2", vector: [0, 1, 0], content: "B" },
    ]);

    const results = await store.search([1, 0, 0], { minScore: 0.9 });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "d1");
  });

  it("deletes documents", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: "d1", vector: [1, 0, 0], content: "A" },
      { id: "d2", vector: [0, 1, 0], content: "B" },
    ]);
    assert.equal(await store.count(), 2);

    await store.delete(["d1"]);
    assert.equal(await store.count(), 1);

    const results = await store.search([1, 0, 0]);
    assert.equal(results[0]!.id, "d2");
  });

  it("respects metadata filters", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      {
        id: "d1",
        vector: [1, 0, 0],
        content: "repo alpha",
        metadata: { scopeType: "repo", scopeId: "alpha" },
      },
      {
        id: "d2",
        vector: [1, 0, 0],
        content: "repo beta",
        metadata: { scopeType: "repo", scopeId: "beta" },
      },
    ]);

    const results = await store.search([1, 0, 0], {
      filter: { scopeType: "repo", scopeId: "beta" },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]!.id, "d2");
  });

  it("upsert updates existing document", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: "d1", vector: [1, 0, 0], content: "Original" },
    ]);
    await store.upsert([
      { id: "d1", vector: [0, 1, 0], content: "Updated" },
    ]);

    assert.equal(await store.count(), 1);
    const results = await store.search([0, 1, 0]);
    assert.equal(results[0]!.content, "Updated");
  });
});

describe("buildEmbeddingText", () => {
  it("combines record fields for embedding", () => {
    const record: MemoryRecord = {
      id: "r1",
      scope: { type: "repo", id: "test" },
      kind: "repo_convention",
      content: "Use ESM modules",
      summary: "ESM only",
      confidence: 1,
      importance: 1,
      source: "test",
      tags: ["esm", "modules"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const text = buildEmbeddingText(record);
    assert.ok(text.includes("repo_convention"));
    assert.ok(text.includes("ESM only"));
    assert.ok(text.includes("Use ESM modules"));
    assert.ok(text.includes("esm"));
  });
});

describe("RetrievalManager with vector store", () => {
  it("merges results across multiple scope filters", async () => {
    const vectorStore = new InMemoryVectorStore();
    await vectorStore.upsert([
      {
        id: "alpha",
        vector: [1, 0, 0],
        content: "alpha repo",
        metadata: { scopeType: "repo", scopeId: "alpha" },
      },
      {
        id: "beta",
        vector: [0.98, 0.02, 0],
        content: "beta repo",
        metadata: { scopeType: "repo", scopeId: "beta" },
      },
      {
        id: "noise-1",
        vector: [0.999, 0.001, 0],
        content: "noise",
        metadata: { scopeType: "repo", scopeId: "noise-1" },
      },
      {
        id: "noise-2",
        vector: [0.999, 0.001, 0],
        content: "noise",
        metadata: { scopeType: "repo", scopeId: "noise-2" },
      },
      {
        id: "noise-3",
        vector: [0.999, 0.001, 0],
        content: "noise",
        metadata: { scopeType: "repo", scopeId: "noise-3" },
      },
      {
        id: "noise-4",
        vector: [0.999, 0.001, 0],
        content: "noise",
        metadata: { scopeType: "repo", scopeId: "noise-4" },
      },
    ]);

    const records: MemoryRecord[] = [
      {
        id: "alpha",
        scope: { type: "repo", id: "alpha" },
        kind: "fact",
        content: "Alpha repo memory",
        confidence: 1,
        importance: 1,
        source: "test",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "beta",
        scope: { type: "repo", id: "beta" },
        kind: "fact",
        content: "Beta repo memory",
        confidence: 1,
        importance: 1,
        source: "test",
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    const manager = new RetrievalManager({
      memory: {
        async search() {
          return [];
        },
        async list(options) {
          if (!options?.scopes?.length) {
            return records;
          }
          const allowed = new Set(options.scopes.map((scope) => `${scope.type}:${scope.id}`));
          return records.filter((record) => allowed.has(`${record.scope.type}:${record.scope.id}`));
        },
      },
      vectorStore,
      embeddingProvider: {
        id: "test",
        async embedQuery() {
          return [1, 0, 0];
        },
        async embedDocuments(texts) {
          return texts.map(() => [1, 0, 0]);
        },
      },
    });

    const hits = await manager.search("repo memory", {
      scopes: [
        { type: "repo", id: "alpha" },
        { type: "repo", id: "beta" },
      ],
      maxResults: 2,
    });

    assert.deepEqual(
      new Set(hits.map((hit) => hit.record!.id)),
      new Set(["alpha", "beta"]),
    );
  });
});
