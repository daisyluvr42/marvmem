import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMarvMem } from "../src/core/index.js";
import { runMemoryReliabilityMigration } from "../src/system/migration.js";

test("offline reliability migration backs up and compacts oversized session metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-migration-"));
  const path = join(root, "memory.sqlite");
  const memory = createMarvMem({ storage: { backend: "sqlite", path } });
  const record = await memory.remember({
    scope: { type: "agent", id: "codex" },
    kind: "note",
    content: "Legacy session summary.",
    source: "codex_session_import",
    tags: ["codex", "session"],
    metadata: { sessionId: "legacy", taskId: "codex:legacy" },
  });
  const oversized = {
    sessionId: "legacy",
    taskId: "codex:legacy",
    messageCount: 2,
    transcript: [
      { role: "user", content: "Please migrate this transcript." },
      { role: "assistant", content: "The transcript belongs in task context." },
    ],
    markerHistory: Array.from({ length: 200 }, (_, index) => ({
      source: "codex",
      metadata: { index, transcript: "x".repeat(2_000) },
    })),
  };
  using db = new DatabaseSync(path);
  db.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?").run(
    JSON.stringify(oversized),
    record.id,
  );

  const result = await runMemoryReliabilityMigration(path);

  assert.equal(result.applied, true);
  assert.ok(result.backupPath);
  assert.equal((await stat(result.backupPath!)).size > 0, true);
  assert.equal(result.recordsCompacted, 1);
  assert.equal(result.transcriptEntriesMigrated, 2);
  using migrated = new DatabaseSync(path);
  const row = migrated
    .prepare("SELECT LENGTH(metadata_json) AS bytes FROM memory_items WHERE id = ?")
    .get(record.id) as { bytes: number };
  assert.equal(Number(row.bytes) <= 8_192, true);
  const taskEntries = migrated
    .prepare("SELECT COUNT(*) AS count FROM task_context_entries WHERE task_id = ?")
    .get("codex:legacy") as { count: number };
  assert.equal(Number(taskEntries.count), 2);
});
