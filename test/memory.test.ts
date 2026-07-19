import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMarvMem, InMemoryStore, SqliteMemoryStore } from "../src/core/index.js";
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

test("search hits expose evidence refs for exact follow-up reads", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "task", id: "release" },
    kind: "decision",
    content: "Use a short release checklist with direct verification steps.",
    source: "codex_session_commit",
    tags: ["release"],
    metadata: { taskId: "codex:release-1", sessionId: "s1" },
  });

  const hits = await memory.search("release checklist", {
    scopes: [{ type: "task", id: "release" }],
  });

  assert.equal(hits[0]?.evidence.recordId, record.id);
  assert.deepEqual(hits[0]?.evidence.tools[0], {
    name: "memory_record",
    arguments: { action: "get", id: record.id },
  });
  assert.deepEqual(hits[0]?.evidence.tools[1], {
    name: "memory_task",
    arguments: { action: "window", taskId: "codex:release-1", message: "<current query>" },
  });
});

test("builds memory navigation from existing records", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  const record = await memory.remember({
    scope: { type: "repo", id: "marvmem" },
    kind: "lesson",
    content: "Keep recall navigation lightweight and point back to exact records.",
    importance: 0.9,
  });

  const navigation = await memory.buildNavigation({
    scopes: [{ type: "repo", id: "marvmem" }],
  });

  assert.match(navigation, /Memory navigation/);
  assert.match(navigation, new RegExp(`memory_record\\(action=get, id=${record.id}\\)`));
  assert.match(navigation, /lightweight and point back to exact records/);
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

test("session identity prevents similar sessions from merging and bounds metadata", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  for (let index = 0; index < 40; index += 1) {
    await memory.remember({
      scope: { type: "agent", id: "codex" },
      kind: "note",
      content: `Session one summary revision ${index}.`,
      source: "codex_session_import",
      tags: ["codex", "session"],
      metadata: {
        sessionId: "session-1",
        taskId: "codex:session-1",
        messageCount: index,
        markerHistory: Array.from({ length: 50 }, (_, marker) => ({
          source: "codex",
          metadata: { transcript: "x".repeat(2_000), marker },
        })),
      },
    });
  }
  await memory.remember({
    scope: { type: "agent", id: "codex" },
    kind: "note",
    content: "Session two has a similar summary.",
    source: "codex_session_import",
    tags: ["codex", "session"],
    metadata: {
      sessionId: "session-2",
      taskId: "codex:session-2",
    },
  });

  const records = await memory.list({ scopes: [{ type: "agent", id: "codex" }] });
  assert.equal(records.length, 2);
  const first = records.find((record) => record.metadata?.sessionId === "session-1");
  assert.ok(first);
  assert.equal(JSON.stringify(first.metadata).length <= 8_192, true);
  assert.equal(Array.isArray(first.metadata?.markerHistory), true);
  assert.equal((first.metadata?.markerHistory as unknown[]).length <= 8, true);
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

test("sqlite write waits for another process instead of failing while locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-sqlite-locked-"));
  const path = join(root, "memory.sqlite");
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(path)}, { timeout: 10000 });
    db.exec("PRAGMA busy_timeout = 10000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY);");
    db.exec("BEGIN IMMEDIATE;");
    db.prepare("INSERT INTO lock_probe DEFAULT VALUES").run();
    console.log("locked");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
      console.log("released");
    }, 250);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + 2_000;
  while (!stdout.includes("locked")) {
    const exit = child.exitCode;
    if (exit !== null) {
      assert.fail(`lock holder exited early (${exit}): ${stderr}`);
    }
    if (Date.now() > deadline) {
      child.kill();
      assert.fail(`lock holder did not acquire lock: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const memory = createMarvMem({ storage: { backend: "sqlite", path } });
  await memory.remember({
    scope: { type: "agent", id: "workbuddy" },
    kind: "note",
    content: "WorkBuddy write waited for the database lock.",
    source: "workbuddy",
  });

  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  const all = await memory.list();
  assert.equal(all.length, 1);
  assert.match(all[0]!.content, /waited for the database lock/);
});

test("sqlite task appends from separate instances keep a single sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-task-concurrent-"));
  const path = join(root, "memory.sqlite");
  const first = createMarvMem({ storage: { backend: "sqlite", path } });
  const second = createMarvMem({ storage: { backend: "sqlite", path } });
  const taskId = "shared-session";

  await first.task.create({
    taskId,
    scope: { type: "agent", id: "codex" },
    title: "Shared session",
  });

  const entries = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 === 0 ? first : second).task.appendEntry({
        taskId,
        role: "assistant",
        content: `entry ${index}`,
      }),
    ),
  );

  assert.equal(entries.filter(Boolean).length, 12);
  const reader = createMarvMem({ storage: { backend: "sqlite", path } });
  const stored = await reader.task.listEntries(taskId);
  assert.deepEqual(
    stored.map((entry) => entry.sequence),
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
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

test("forget soft-deletes and restore makes a record visible again", async () => {
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
  const tombstone = await memory.get(record.id, { includeDeleted: true });
  assert.equal(typeof tombstone?.deletedAt, "string");

  const deletedAgain = await memory.forget(record.id);
  assert.equal(deletedAgain, false);
  const restored = await memory.restore(record.id);
  assert.equal(restored?.id, record.id);
  assert.equal((await memory.get(record.id))?.content, "Temporary fact.");
});

test("sqlite save round-trip preserves tombstones and excludes hidden records from FTS", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-roundtrip-"));
  const path = join(root, "memory.sqlite");
  const store = new SqliteMemoryStore(path);
  const record = {
    id: "deleted-record",
    scope: { type: "repo" as const, id: "marvmem" },
    kind: "fact",
    content: "This record must remain deleted after cloud-style save.",
    summary: "Deleted record",
    confidence: 0.8,
    importance: 0.7,
    source: "test",
    tags: ["deleted"],
    metadata: { projectId: "p1" },
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T01:00:00.000Z",
    deletedAt: "2026-07-19T01:00:00.000Z",
    deletedBy: "test",
    deleteReason: "round-trip",
    supersededBy: "winner",
  };
  await store.save([record]);
  await store.save(await store.load());

  const loaded = (await store.load())[0];
  assert.equal(loaded?.deletedAt, record.deletedAt);
  assert.equal(loaded?.deletedBy, "test");
  assert.equal(loaded?.deleteReason, "round-trip");
  assert.equal(loaded?.supersededBy, "winner");
  using db = new DatabaseSync(path);
  const fts = db.prepare("SELECT COUNT(*) AS count FROM memory_items_fts").get() as { count: number };
  assert.equal(Number(fts.count), 0);
});

test("sqlite FTS search escapes special syntax and filters workbuddy documents", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-fts-"));
  const path = join(root, "memory.sqlite");
  const memory = createMarvMem({ storage: { backend: "sqlite", path } });
  await memory.remember({
    scope: { type: "repo", id: "marvmem" },
    kind: "fact",
    content: "Use NEAR-safe release tags such as alpha-beta * without exposing FTS syntax.",
    source: "manual",
  });
  await memory.remember({
    scope: { type: "agent", id: "workbuddy" },
    kind: "identity",
    content: "SOUL.md full document anchor should not consume recall.",
    source: "workbuddy_document",
    metadata: { projectionDocument: true, projectionTarget: "soul" },
  }, { dedupe: false });

  const hits = await memory.search('NEAR alpha-beta * "release"', { minScore: 0 });
  assert.equal(hits.some((hit) => hit.record.source === "manual"), true);
  assert.equal(hits.some((hit) => hit.record.source === "workbuddy_document"), false);
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
