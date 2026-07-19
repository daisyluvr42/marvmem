import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compactSessionMetadata } from "../core/memory.js";
import { openSqliteDatabase } from "./sqlite.js";

const MIGRATION_ID = "2026-07-19-memory-metadata-and-soft-delete";
const MAX_METADATA_BYTES = 8_192;

export type MemoryReliabilityMigrationResult = {
  applied: boolean;
  storagePath: string;
  backupPath?: string;
  backupBytes?: number;
  recordsCompacted: number;
  metadataBytesRemoved: number;
  transcriptEntriesMigrated: number;
  vacuumed: boolean;
};

export async function runMemoryReliabilityMigration(
  storagePath: string,
): Promise<MemoryReliabilityMigrationResult> {
  const resolvedPath = resolve(storagePath);
  await stat(resolvedPath);
  if (isMigrationApplied(resolvedPath)) {
    return {
      applied: false,
      storagePath: resolvedPath,
      recordsCompacted: 0,
      metadataBytesRemoved: 0,
      transcriptEntriesMigrated: 0,
      vacuumed: false,
    };
  }

  const backupPath = await createBackup(resolvedPath);
  const backupBytes = (await stat(backupPath)).size;
  let recordsCompacted = 0;
  let metadataBytesRemoved = 0;
  let transcriptEntriesMigrated = 0;

  using db = openSqliteDatabase(resolvedPath);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT id FROM schema_migrations WHERE id = ?")
      .get(MIGRATION_ID) as { id?: string } | undefined;
    if (existing?.id) {
      db.exec("COMMIT");
      return {
        applied: false,
        storagePath: resolvedPath,
        backupPath,
        backupBytes,
        recordsCompacted: 0,
        metadataBytesRemoved: 0,
        transcriptEntriesMigrated: 0,
        vacuumed: false,
      };
    }

    const ids = db
      .prepare(
        "SELECT id FROM memory_items WHERE metadata_json IS NOT NULL AND LENGTH(metadata_json) > ?",
      )
      .all(MAX_METADATA_BYTES) as Array<{ id: string }>;
    const read = db.prepare(
      "SELECT id, scope_type, scope_id, kind, source, tags_json, metadata_json, created_at " +
        "FROM memory_items WHERE id = ?",
    );
    const update = db.prepare("UPDATE memory_items SET metadata_json = ? WHERE id = ?");
    for (const { id } of ids) {
      const row = read.get(id) as {
        id: string;
        scope_type: string;
        scope_id: string;
        kind: string;
        source: string;
        tags_json: string;
        metadata_json: string;
        created_at: string;
      };
      const metadata = parseObject(row.metadata_json);
      if (!metadata) {
        update.run(null, id);
        recordsCompacted += 1;
        metadataBytesRemoved += row.metadata_json.length;
        continue;
      }
      transcriptEntriesMigrated += migrateTranscriptEntries(db, row, metadata);
      const sessionRecord =
        row.kind === "note" &&
        (row.source.includes("_session_") || parseStringArray(row.tags_json).includes("session"));
      const compacted = sessionRecord
        ? compactSessionMetadata(metadata) ?? {}
        : compactLargeMetadata(metadata);
      const nextJson = JSON.stringify({
        ...compacted,
        metadataMigration: MIGRATION_ID,
        originalMetadataBytes: row.metadata_json.length,
      });
      const boundedJson = nextJson.length <= MAX_METADATA_BYTES
        ? nextJson
        : JSON.stringify({
            metadataMigration: MIGRATION_ID,
            originalMetadataBytes: row.metadata_json.length,
            sessionId: scalar(metadata.sessionId),
            taskId: scalar(metadata.taskId),
            agent: scalar(metadata.agent),
          });
      update.run(boundedJson, id);
      recordsCompacted += 1;
      metadataBytesRemoved += Math.max(0, row.metadata_json.length - boundedJson.length);
    }

    db.exec("DELETE FROM memory_items_fts");
    db.exec(
      "INSERT INTO memory_items_fts (id, kind, content, summary, tags, scope) " +
        "SELECT id, kind, content, COALESCE(summary, ''), tags_json, scope_type || ':' || scope_id " +
        "FROM memory_items WHERE deleted_at IS NULL AND superseded_by IS NULL " +
        "AND source <> 'workbuddy_document'",
    );
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
      MIGRATION_ID,
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const vacuumed = metadataBytesRemoved > 16 * 1024 * 1024;
  if (vacuumed) {
    db.exec("VACUUM");
  }
  return {
    applied: true,
    storagePath: resolvedPath,
    backupPath,
    backupBytes,
    recordsCompacted,
    metadataBytesRemoved,
    transcriptEntriesMigrated,
    vacuumed,
  };
}

function isMigrationApplied(storagePath: string): boolean {
  using db = new DatabaseSync(storagePath, { timeout: 10_000 });
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name?: string } | undefined;
  if (!table?.name) {
    return false;
  }
  const row = db
    .prepare("SELECT id FROM schema_migrations WHERE id = ?")
    .get(MIGRATION_ID) as { id?: string } | undefined;
  return row?.id === MIGRATION_ID;
}

async function createBackup(storagePath: string): Promise<string> {
  using db = new DatabaseSync(storagePath, { timeout: 10_000 });
  db.exec("PRAGMA busy_timeout = 10000;");
  db.exec("PRAGMA wal_checkpoint(FULL);");
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const directory = dirname(storagePath);
  const prefix = `${basename(storagePath)}.pre-${stamp}`;
  let backupPath = join(directory, `${prefix}.bak`);
  let suffix = 1;
  while (await pathExists(backupPath)) {
    backupPath = join(directory, `${prefix}-${suffix}.bak`);
    suffix += 1;
  }
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  return backupPath;
}

function compactLargeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const removedFields: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      output[key] = value;
      if (JSON.stringify(output).length > MAX_METADATA_BYTES - 512) {
        delete output[key];
        removedFields.push(key);
      }
    } else {
      removedFields.push(key);
    }
  }
  if (removedFields.length > 0) {
    output.removedMetadataFields = removedFields.slice(0, 64);
  }
  return output;
}

function migrateTranscriptEntries(
  db: DatabaseSync,
  row: {
    id: string;
    scope_type: string;
    scope_id: string;
    metadata_json: string;
    created_at: string;
  },
  metadata: Record<string, unknown>,
): number {
  const taskId = typeof metadata.taskId === "string" && metadata.taskId.trim()
    ? metadata.taskId.trim()
    : undefined;
  if (!taskId) {
    return 0;
  }
  const rawEntries = [metadata.transcript, metadata.messages, metadata.entries]
    .find(Array.isArray);
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    return 0;
  }
  const now = Date.now();
  db.prepare(
    "INSERT INTO task_context (task_id, scope_type, scope_id, title, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, 'completed', ?, ?) ON CONFLICT(task_id) DO NOTHING",
  ).run(taskId, row.scope_type, row.scope_id, taskId, now, now);
  let sequence = Number(
    (db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_context_entries WHERE task_id = ?")
      .get(taskId) as { sequence?: number } | undefined)?.sequence ?? 0,
  );
  let inserted = 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO task_context_entries (" +
      "id, task_id, sequence, role, content, summary, token_count, created_at, metadata_json, summarized" +
      ") VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)",
  );
  for (const entry of rawEntries) {
    const parsed = entry && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined;
    const content = typeof parsed?.content === "string"
      ? parsed.content.trim()
      : typeof entry === "string"
        ? entry.trim()
        : "";
    if (!content) {
      continue;
    }
    sequence += 1;
    const role = normalizeRole(parsed?.role);
    const id = `migration:${createHash("sha256")
      .update(`${taskId}\0${sequence}\0${role}\0${content}`)
      .digest("hex")}`;
    const result = insert.run(
      id,
      taskId,
      sequence,
      role,
      content,
      Math.ceil(content.length / 4),
      Date.parse(row.created_at) || now,
      JSON.stringify({ migratedFromMemoryId: row.id, migration: MIGRATION_ID }),
    );
    inserted += Number(result.changes ?? 0);
  }
  return inserted;
}

function normalizeRole(value: unknown): "user" | "assistant" | "system" | "tool" {
  return value === "user" || value === "assistant" || value === "system" || value === "tool"
    ? value
    : "assistant";
}

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function scalar(value: unknown): string | number | boolean | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
