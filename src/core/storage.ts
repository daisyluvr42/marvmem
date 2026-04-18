import fs from "node:fs/promises";
import path from "node:path";
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

export class FileMemoryStore implements MemoryStore {
  private cache: MemoryRecord[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<MemoryRecord[]> {
    if (this.cache) {
      return cloneRecords(this.cache);
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MemoryRecord[];
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = [];
      } else {
        throw error;
      }
    }
    return cloneRecords(this.cache);
  }

  async save(records: MemoryRecord[]): Promise<void> {
    this.cache = cloneRecords(records);
    // Serialize writes so concurrent save() calls don't interleave I/O
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
    });
    await this.writeQueue;
  }
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
}

export class InMemoryStore implements MemoryStore {
  private records: MemoryRecord[] = [];

  async load(): Promise<MemoryRecord[]> {
    return cloneRecords(this.records);
  }

  async save(records: MemoryRecord[]): Promise<void> {
    this.records = cloneRecords(records);
  }
}
