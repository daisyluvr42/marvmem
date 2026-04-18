import { DatabaseSync } from "node:sqlite";
import { normalizeScope, type MemoryScope } from "../core/types.js";
import { openSqliteDatabase, parseJsonObject } from "../system/sqlite.js";
import type { ActiveMemoryDocument, ActiveMemoryKind, ActiveMemoryStore } from "./types.js";

type ActiveDocumentRow = {
  kind: string;
  scope_type: string;
  scope_id: string;
  content: string;
  metadata_json: string | null;
  updated_at: string;
};

export class SqliteActiveMemoryStore implements ActiveMemoryStore {
  constructor(private readonly filePath: string) {}

  async get(kind: ActiveMemoryKind, scope: MemoryScope): Promise<ActiveMemoryDocument | null> {
    const normalizedScope = normalizeScope(scope);
    using db = openSqliteDatabase(this.filePath);
    const row = db
      .prepare(
        "SELECT kind, scope_type, scope_id, content, metadata_json, updated_at " +
          "FROM active_documents WHERE kind = ? AND scope_type = ? AND scope_id = ?",
      )
      .get(kind, normalizedScope.type, normalizedScope.id) as ActiveDocumentRow | undefined;
    return row ? rowToDocument(row) : null;
  }

  async put(
    document: Omit<ActiveMemoryDocument, "updatedAt"> & { updatedAt?: string },
  ): Promise<ActiveMemoryDocument> {
    const normalizedScope = normalizeScope(document.scope);
    const updatedAt = document.updatedAt ?? new Date().toISOString();
    using db = openSqliteDatabase(this.filePath);
    db.prepare(
      "INSERT INTO active_documents (" +
        "kind, scope_type, scope_id, content, metadata_json, updated_at" +
        ") VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(kind, scope_type, scope_id) DO UPDATE SET " +
        "content = excluded.content, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at",
    ).run(
      document.kind,
      normalizedScope.type,
      normalizedScope.id,
      document.content,
      document.metadata ? JSON.stringify(document.metadata) : null,
      updatedAt,
    );
    return {
      kind: document.kind,
      scope: normalizedScope,
      content: document.content,
      metadata: document.metadata,
      updatedAt,
    };
  }

  async delete(kind: ActiveMemoryKind, scope: MemoryScope): Promise<boolean> {
    const normalizedScope = normalizeScope(scope);
    using db = openSqliteDatabase(this.filePath);
    db.prepare("DELETE FROM active_documents WHERE kind = ? AND scope_type = ? AND scope_id = ?").run(
      kind,
      normalizedScope.type,
      normalizedScope.id,
    );
    const result = db.prepare("SELECT changes() AS changes").get() as { changes?: number } | undefined;
    return Number(result?.changes ?? 0) > 0;
  }
}

export class InMemoryActiveMemoryStore implements ActiveMemoryStore {
  private readonly documents = new Map<string, ActiveMemoryDocument>();

  async get(kind: ActiveMemoryKind, scope: MemoryScope): Promise<ActiveMemoryDocument | null> {
    return this.documents.get(keyFor(kind, scope)) ?? null;
  }

  async put(
    document: Omit<ActiveMemoryDocument, "updatedAt"> & { updatedAt?: string },
  ): Promise<ActiveMemoryDocument> {
    const normalizedScope = normalizeScope(document.scope);
    const stored: ActiveMemoryDocument = {
      kind: document.kind,
      scope: normalizedScope,
      content: document.content,
      metadata: document.metadata ? { ...document.metadata } : undefined,
      updatedAt: document.updatedAt ?? new Date().toISOString(),
    };
    this.documents.set(keyFor(document.kind, normalizedScope), stored);
    return stored;
  }

  async delete(kind: ActiveMemoryKind, scope: MemoryScope): Promise<boolean> {
    return this.documents.delete(keyFor(kind, scope));
  }
}

function rowToDocument(row: ActiveDocumentRow): ActiveMemoryDocument {
  return {
    kind: row.kind as ActiveMemoryKind,
    scope: { type: row.scope_type as MemoryScope["type"], id: row.scope_id },
    content: row.content,
    metadata: parseJsonObject(row.metadata_json),
    updatedAt: row.updated_at,
  };
}

function keyFor(kind: ActiveMemoryKind, scope: MemoryScope): string {
  const normalized = normalizeScope(scope);
  return `${kind}:${normalized.type}:${normalized.id}`;
}
