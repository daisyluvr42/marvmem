import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openSqliteDatabase(filePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureMemorySubsystemSchema(db);
  return db;
}

export function ensureMemorySubsystemSchema(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS memory_items (" +
      "id TEXT PRIMARY KEY, " +
      "scope_type TEXT NOT NULL, " +
      "scope_id TEXT NOT NULL, " +
      "scope_weight REAL, " +
      "kind TEXT NOT NULL, " +
      "content TEXT NOT NULL, " +
      "summary TEXT, " +
      "confidence REAL NOT NULL, " +
      "importance REAL NOT NULL, " +
      "source TEXT NOT NULL, " +
      "tags_json TEXT NOT NULL, " +
      "metadata_json TEXT, " +
      "created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL" +
      ");",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_memory_items_scope " +
      "ON memory_items(scope_type, scope_id, updated_at DESC);",
  );
  db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(" +
      "id UNINDEXED, " +
      "kind, " +
      "content, " +
      "summary, " +
      "tags, " +
      "scope" +
      ");",
  );

  db.exec(
    "CREATE TABLE IF NOT EXISTS active_documents (" +
      "kind TEXT NOT NULL, " +
      "scope_type TEXT NOT NULL, " +
      "scope_id TEXT NOT NULL, " +
      "content TEXT NOT NULL, " +
      "metadata_json TEXT, " +
      "updated_at TEXT NOT NULL, " +
      "PRIMARY KEY (kind, scope_type, scope_id)" +
      ");",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_active_documents_scope " +
      "ON active_documents(scope_type, scope_id, kind);",
  );

  db.exec(
    "CREATE TABLE IF NOT EXISTS task_context (" +
      "task_id TEXT PRIMARY KEY, " +
      "scope_type TEXT NOT NULL, " +
      "scope_id TEXT NOT NULL, " +
      "title TEXT NOT NULL, " +
      "status TEXT NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      ");",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS task_context_entries (" +
      "id TEXT PRIMARY KEY, " +
      "task_id TEXT NOT NULL, " +
      "sequence INTEGER NOT NULL, " +
      "role TEXT NOT NULL, " +
      "content TEXT NOT NULL, " +
      "summary TEXT, " +
      "token_count INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "metadata_json TEXT, " +
      "summarized INTEGER NOT NULL DEFAULT 0, " +
      "FOREIGN KEY (task_id) REFERENCES task_context(task_id) ON DELETE CASCADE" +
      ");",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_task_context_entries_task_seq " +
      "ON task_context_entries(task_id, sequence);",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS task_context_state (" +
      "task_id TEXT PRIMARY KEY, " +
      "rolling_summary TEXT, " +
      "updated_at INTEGER NOT NULL, " +
      "FOREIGN KEY (task_id) REFERENCES task_context(task_id) ON DELETE CASCADE" +
      ");",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS task_context_bookmarks (" +
      "id TEXT PRIMARY KEY, " +
      "task_id TEXT NOT NULL, " +
      "kind TEXT NOT NULL, " +
      "content TEXT NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "metadata_json TEXT, " +
      "FOREIGN KEY (task_id) REFERENCES task_context(task_id) ON DELETE CASCADE" +
      ");",
  );

  db.exec(
    "CREATE TABLE IF NOT EXISTS entities (" +
      "id TEXT PRIMARY KEY, " +
      "name TEXT NOT NULL, " +
      "name_key TEXT NOT NULL UNIQUE, " +
      "aliases_json TEXT NOT NULL, " +
      "kind TEXT NOT NULL, " +
      "metadata_json TEXT, " +
      "created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL" +
      ");",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);");
  db.exec(
    "CREATE TABLE IF NOT EXISTS entity_links (" +
      "entity_id TEXT NOT NULL, " +
      "memory_id TEXT NOT NULL, " +
      "relation TEXT NOT NULL, " +
      "confidence REAL NOT NULL, " +
      "created_at TEXT NOT NULL, " +
      "PRIMARY KEY (entity_id, memory_id, relation), " +
      "FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE" +
      ");",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_links_memory ON entity_links(memory_id);");
  db.exec(
    "CREATE TABLE IF NOT EXISTS entity_relations (" +
      "id TEXT PRIMARY KEY, " +
      "source_entity_id TEXT NOT NULL, " +
      "target_entity_id TEXT NOT NULL, " +
      "relation TEXT NOT NULL, " +
      "memory_id TEXT, " +
      "confidence REAL NOT NULL, " +
      "created_at TEXT NOT NULL, " +
      "FOREIGN KEY (source_entity_id) REFERENCES entities(id) ON DELETE CASCADE, " +
      "FOREIGN KEY (target_entity_id) REFERENCES entities(id) ON DELETE CASCADE" +
      ");",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_entity_relations_memory ON entity_relations(memory_id);");
}

export function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
