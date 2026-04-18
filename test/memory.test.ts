import test from "node:test";
import assert from "node:assert/strict";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";

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
  });
  const second = await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "preference",
    content: "Alice prefers concise Chinese replies.",
    importance: 0.9,
  });

  // Should have merged: same id, updated importance
  assert.equal(first.id, second.id);
  assert.equal(second.importance, 0.9);
  const all = await memory.list({ scopes: [{ type: "user", id: "alice" }] });
  assert.equal(all.length, 1);
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
