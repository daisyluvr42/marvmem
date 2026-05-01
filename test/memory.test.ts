import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";
import { InMemoryVectorStore } from "../src/retrieval/vector-memory.js";
import { InMemoryEntityStore } from "../src/entity/store-memory.js";

test("remembers and searches scoped memories", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers concise Chinese replies.",
    importance: 0.9,
  });
  await memory.remember({
    scope: { type: "user", id: "bob" },
    kind: "preference",
    content: "Bob prefers detailed English replies.",
  });

  const hits = await memory.search("What reply style does Alice prefer?", {
    scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  });

  assert.equal(hits.length, 1);
  assert.match(hits[0]!.record.content, /Alice prefers concise Chinese replies/);
});

test("builds prompt-ready recall context", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "User prefers concise replies in Chinese.",
  });

  const recall = await memory.recall({
    query: "How should I answer this user?",
    scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  });

  assert.equal(recall.hits.length, 1);
  assert.match(recall.injectedContext, /Relevant long-term memory/);
  assert.match(recall.injectedContext, /prefers concise replies in Chinese/);
});

test("deduplicates similar memories instead of creating duplicates", async () => {
  const memory = createMarvMem({ store: new InMemoryStore(), dedupeThreshold: 0.85 });

  const first = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers concise Chinese replies.",
    importance: 0.5,
    source: "codex",
    tags: ["codex"],
    metadata: { sessionId: "c1" },
  });
  const second = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers concise Chinese replies.",
    importance: 0.9,
    source: "claude",
    tags: ["claude"],
    metadata: { sessionId: "c2", projectPath: "/repo" },
  });

  // Should have merged: same id, updated importance
  assert.equal(first.id, second.id);
  assert.equal(second.importance, 0.9);
  assert.deepEqual(second.tags, ["codex", "claude"]);
  assert.deepEqual(second.metadata, {
    sessionId: "c1",
    projectPath: "/repo",
    sourceHistory: ["codex", "claude"],
    markerHistory: [
      {
        source: "claude",
        tags: ["claude"],
        metadata: { sessionId: "c2", projectPath: "/repo" },
      },
    ],
  });
  const all = await memory.list({ scopes: [{ type: "user", id: "alice" }] });
  assert.equal(all.length, 1);
});

test("sqlite stores concurrent writes from separate instances without clobbering", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-sqlite-concurrent-"));
  const path = join(root, "memory.sqlite");
  const first = createMarvMem({ storage: { backend: "sqlite", path } });
  const second = createMarvMem({ storage: { backend: "sqlite", path } });

  await Promise.all([
    first.remember({
      scope: { type: "agent", id: "codex" },
      kind: "note",
      content: "Codex wrote the release note.",
      source: "codex",
    }),
    second.remember({
      scope: { type: "agent", id: "claude" },
      kind: "note",
      content: "Claude wrote the migration note.",
      source: "claude",
    }),
  ]);

  const reader = createMarvMem({ storage: { backend: "sqlite", path } });
  const all = await reader.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((record) => record.source).sort(), ["claude", "codex"]);
});

test("update modifies an existing record", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers English.",
  });

  const updated = await memory.update(record.id, { content: "Alice prefers Chinese." });
  assert.ok(updated);
  assert.match(updated!.content, /Chinese/);

  const fetched = await memory.get(record.id);
  assert.match(fetched!.content, /Chinese/);
});

test("forget deletes a record", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "fact",
    content: "Temporary fact.",
  });

  const deleted = await memory.forget(record.id);
  assert.equal(deleted, true);

  const fetched = await memory.get(record.id);
  assert.equal(fetched, null);

  const deletedAgain = await memory.forget(record.id);
  assert.equal(deletedAgain, false);
});

test("search returns hash-based reasons (not semantic)", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "fact",
    content: "Alice's favorite color is blue.",
  });

  const hits = await memory.search("blue color", {
    scopes: [{ type: "user", id: "alice", weight: 1 }],
  });
  assert.ok(hits.length > 0);
  assert.ok("hash" in hits[0]!.reasons);
  assert.equal("semantic" in hits[0]!.reasons, false);
});

test("search filters unrelated memories by default", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "fact",
    content: "Alice likes strawberries.",
  });

  const hits = await memory.search("server deployment rollback plan", {
    scopes: [{ type: "user", id: "alice", weight: 1 }],
  });

  assert.equal(hits.length, 0);
});

test("remember and forget keep the vector index in sync", async () => {
  const vectorStore = new InMemoryVectorStore();
  const memory = createMarvMem({
    store: new InMemoryStore(),
    retrieval: { vectorStore },
  });

  const record = await memory.remember({
    scope: { type: "repo", id: "marvmem" },
    kind: "fact",
    content: "This repo uses ESM modules.",
  });

  assert.equal(await vectorStore.count(), 1);

  await memory.forget(record.id);
  assert.equal(await vectorStore.count(), 0);
});

test("entity links can surface alias-based searches", async () => {
  const entityStore = new InMemoryEntityStore();
  const memory = createMarvMem({
    store: new InMemoryStore(),
    entityStore,
    entityExtractor: {
      async extract(text: string) {
        if (text.toLowerCase().includes("typescript")) {
          return [{ name: "TypeScript", kind: "tech", aliases: ["TS"] }];
        }
        return [];
      },
    },
  });

  await memory.remember({
    scope: { type: "repo", id: "marvmem" },
    kind: "fact",
    content: "This project uses TypeScript for the backend.",
  });

  const hits = await memory.search("TS", {
    scopes: [{ type: "repo", id: "marvmem", weight: 1 }],
  });

  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.record.content, "This project uses TypeScript for the backend.");
  assert.equal(hits[0]!.reasons.entity, 1);
});

test("recall includes related entity graph context", async () => {
  const entityStore = new InMemoryEntityStore();
  const memory = createMarvMem({
    store: new InMemoryStore(),
    entityStore,
    entityExtractor: {
      async extract(text: string) {
        const entities = [];
        if (text.toLowerCase().includes("react")) {
          entities.push({ name: "React", kind: "tech" as const });
        }
        if (text.toLowerCase().includes("next.js")) {
          entities.push({ name: "Next.js", kind: "tech" as const });
        }
        return entities;
      },
    },
  });

  await memory.remember({
    scope: { type: "repo", id: "marvmem" },
    kind: "fact",
    content: "This project uses React with Next.js.",
  });

  const recall = await memory.recall({
    query: "React",
    scopes: [{ type: "repo", id: "marvmem" }],
  });

  assert.ok(recall.injectedContext.includes("Related entity graph"));
  assert.ok(recall.injectedContext.includes("co_occurs"));
});
