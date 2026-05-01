import { openSqliteDatabase, parseJsonObject, parseJsonStringArray } from "../system/sqlite.js";
import type { MemoryRecord, MemoryStore } from "./types.js";

function cloneRecords(records: MemoryRecord[]): MemoryRecord[] {
  return records.map((record) => ({
    ...record,
    scope: { ...record.scope },
    tags: [...record.tags],
    metadata: record.metadata ? { ...record.metadata } : undefined,
  }));
}

type MemoryItemRow = {
  id: string;
  scope_type: string;
  scope_id: string;
  scope_weight: number | null;
  kind: string;
  content: string;
  summary: string | null;
  confidence: number;
  importance: number;
  source: string;
  tags_json: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<MemoryRecord[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db
      .prepare(
        "SELECT id, scope_type, scope_id, scope_weight, kind, content, summary, confidence, importance, source, " +
          "tags_json, metadata_json, created_at, updated_at FROM memory_items ORDER BY created_at ASC",
      )
      .all() as MemoryItemRow[];
    return rows.map((row) => ({
      id: row.id,
      scope: {
        type: row.scope_type as MemoryRecord["scope"]["type"],
        id: row.scope_id,
        weight: row.scope_weight ?? undefined,
      },
      kind: row.kind,
      content: row.content,
      summary: row.summary ?? undefined,
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      source: row.source,
      tags: parseJsonStringArray(row.tags_json),
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async save(records: MemoryRecord[]): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM memory_items_fts");
      db.exec("DELETE FROM memory_items");
      const insertMemory = db.prepare(
        "INSERT INTO memory_items (" +
          "id, scope_type, scope_id, scope_weight, kind, content, summary, confidence, importance, source, tags_json, metadata_json, created_at, updated_at" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertFts = db.prepare(
        "INSERT INTO memory_items_fts (id, kind, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const record of records) {
        insertMemory.run(
          record.id,
          record.scope.type,
          record.scope.id,
          record.scope.weight ?? null,
          record.kind,
          record.content,
          record.summary ?? null,
          record.confidence,
          record.importance,
          record.source,
          JSON.stringify(record.tags),
          record.metadata ? JSON.stringify(record.metadata) : null,
          record.createdAt,
          record.updatedAt,
        );
        insertFts.run(
          record.id,
          record.kind,
          record.content,
          record.summary ?? "",
          record.tags.join(" "),
          `${record.scope.type}:${record.scope.id}`,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async upsert(record: MemoryRecord): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN");
    try {
      db
        .prepare(
          "INSERT INTO memory_items (" +
            "id, scope_type, scope_id, scope_weight, kind, content, summary, confidence, importance, source, tags_json, metadata_json, created_at, updated_at" +
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET " +
            "scope_type = excluded.scope_type, scope_id = excluded.scope_id, scope_weight = excluded.scope_weight, " +
            "kind = excluded.kind, content = excluded.content, summary = excluded.summary, " +
            "confidence = excluded.confidence, importance = excluded.importance, source = excluded.source, " +
            "tags_json = excluded.tags_json, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at",
        )
        .run(
          record.id,
          record.scope.type,
          record.scope.id,
          record.scope.weight ?? null,
          record.kind,
          record.content,
          record.summary ?? null,
          record.confidence,
          record.importance,
          record.source,
          JSON.stringify(record.tags),
          record.metadata ? JSON.stringify(record.metadata) : null,
          record.createdAt,
          record.updatedAt,
        );
      db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(record.id);
      db
        .prepare("INSERT INTO memory_items_fts (id, kind, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          record.id,
          record.kind,
          record.content,
          record.summary ?? "",
          record.tags.join(" "),
          `${record.scope.type}:${record.scope.id}`,
        );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(id);
      db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class InMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = [];

  async load(): Promise<MemoryRecord[]> {
    return cloneRecords(this.records);
  }

  async save(records: MemoryRecord[]): Promise<void> {
    this.records = cloneRecords(records);
  }

  async upsert(record: MemoryRecord): Promise<void> {
    const index = this.records.findIndex((entry) => entry.id === record.id);
    const next = cloneRecords([record])[0]!;
    if (index === -1) {
      this.records.push(next);
    } else {
      this.records[index] = next;
    }
  }

  async delete(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
  }
}
