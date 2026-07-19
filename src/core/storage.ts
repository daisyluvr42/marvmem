import { openSqliteDatabase, parseJsonObject, parseJsonStringArray } from "../system/sqlite.js";
import { tokenOverlapScore, uniqueTokens } from "./tokenize.js";
import type {
  MemoryGetOptions,
  MemoryKind,
  MemoryListOptions,
  MemoryRecord,
  MemoryScope,
  MemoryStore,
  MemoryStoreSearchOptions,
} from "./types.js";

const MEMORY_COLUMNS =
  "id, scope_type, scope_id, scope_weight, kind, content, summary, confidence, importance, source, " +
  "tags_json, metadata_json, created_at, updated_at, deleted_at, deleted_by, delete_reason, superseded_by";
const CANDIDATE_COLUMNS =
  "id, scope_type, scope_id, scope_weight, kind, content, summary, confidence, importance, source, " +
  "tags_json, NULL AS metadata_json, created_at, updated_at, deleted_at, deleted_by, delete_reason, superseded_by";

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
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
  superseded_by: string | null;
};

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<MemoryRecord[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memory_items ORDER BY created_at ASC`)
      .all() as MemoryItemRow[];
    return rows.map(rowToRecord);
  }

  async save(records: MemoryRecord[]): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM memory_items_fts");
      db.exec("DELETE FROM memory_items");
      const insertMemory = db.prepare(
        "INSERT INTO memory_items (" +
          "id, scope_type, scope_id, scope_weight, kind, content, summary, confidence, importance, source, tags_json, metadata_json, created_at, updated_at, deleted_at, deleted_by, delete_reason, superseded_by" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertFts = prepareFtsInsert(db);
      for (const record of records) {
        insertMemory.run(...recordValues(record));
        if (isSearchVisible(record)) {
          insertFts.run(...ftsValues(record));
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async upsert(record: MemoryRecord): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      db
        .prepare(
          "INSERT INTO memory_items (" +
            "id, scope_type, scope_id, scope_weight, kind, content, summary, confidence, importance, source, tags_json, metadata_json, created_at, updated_at, deleted_at, deleted_by, delete_reason, superseded_by" +
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET " +
            "scope_type = excluded.scope_type, scope_id = excluded.scope_id, scope_weight = excluded.scope_weight, " +
            "kind = excluded.kind, content = excluded.content, summary = excluded.summary, " +
            "confidence = excluded.confidence, importance = excluded.importance, source = excluded.source, " +
            "tags_json = excluded.tags_json, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at, " +
            "deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by, " +
            "delete_reason = excluded.delete_reason, superseded_by = excluded.superseded_by",
        )
        .run(...recordValues(record));
      db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(record.id);
      if (isSearchVisible(record)) {
        prepareFtsInsert(db).run(...ftsValues(record));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(id);
      db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async get(id: string, options: MemoryGetOptions = {}): Promise<MemoryRecord | null> {
    using db = openSqliteDatabase(this.filePath);
    const conditions = ["id = ?"];
    const values: Array<string | number> = [id];
    appendVisibilityConditions(conditions, values, {
      ...options,
      includeDocuments: options.includeDocuments ?? true,
    });
    const row = db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memory_items WHERE ${conditions.join(" AND ")}`)
      .get(...values) as MemoryItemRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async getMany(ids: string[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    using db = openSqliteDatabase(this.filePath);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM memory_items ` +
          `WHERE id IN (${placeholders}) AND deleted_at IS NULL AND superseded_by IS NULL ` +
          "AND source <> 'workbuddy_document'",
      )
      .all(...ids) as MemoryItemRow[];
    const byId = new Map(rows.map((row) => [row.id, rowToRecord(row)]));
    return ids.map((id) => byId.get(id)).filter((record): record is MemoryRecord => Boolean(record));
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    using db = openSqliteDatabase(this.filePath);
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    appendVisibilityConditions(conditions, values, options);
    appendScopeConditions(conditions, values, options.scopes);
    const limit = options.limit && options.limit > 0 ? " LIMIT ?" : "";
    if (limit) {
      values.push(Math.floor(options.limit!));
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memory_items${where} ORDER BY updated_at DESC${limit}`)
      .all(...values) as MemoryItemRow[];
    return rows.map(rowToRecord);
  }

  async findDedupeCandidates(scope: MemoryScope, kind: MemoryKind, limit = 64): Promise<MemoryRecord[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db
      .prepare(
        `SELECT ${CANDIDATE_COLUMNS} FROM memory_items ` +
          "WHERE scope_type = ? AND scope_id = ? AND kind = ? " +
          "AND deleted_at IS NULL AND superseded_by IS NULL AND source <> 'workbuddy_document' " +
          "ORDER BY updated_at DESC LIMIT ?",
      )
      .all(scope.type, scope.id, kind, limit) as MemoryItemRow[];
    return rows.map(rowToRecord);
  }

  async findSessionRecord(scope: MemoryScope, sessionId: string, taskId?: string): Promise<MemoryRecord | null> {
    using db = openSqliteDatabase(this.filePath);
    const taskCondition = taskId ? "AND json_extract(metadata_json, '$.taskId') = ? " : "";
    const values = taskId
      ? [scope.type, scope.id, sessionId, taskId]
      : [scope.type, scope.id, sessionId];
    const row = db
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM memory_items ` +
          "WHERE scope_type = ? AND scope_id = ? " +
          "AND deleted_at IS NULL AND superseded_by IS NULL " +
          "AND json_extract(metadata_json, '$.sessionId') = ? " +
          taskCondition +
          "ORDER BY updated_at DESC LIMIT 1",
      )
      .get(...values) as MemoryItemRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  async searchCandidates(query: string, options: MemoryStoreSearchOptions): Promise<MemoryRecord[]> {
    using db = openSqliteDatabase(this.filePath);
    const tokens = uniqueTokens(query).slice(0, 64);
    const byId = new Map<string, MemoryRecord>();
    if (tokens.length > 0) {
      const conditions = [
        "memory_items.deleted_at IS NULL",
        "memory_items.superseded_by IS NULL",
        "memory_items.source <> 'workbuddy_document'",
      ];
      const values: Array<string | number> = [buildFtsQuery(tokens)];
      appendScopeConditions(conditions, values, options.scopes, "memory_items");
      values.push(options.limit);
      const rows = db
        .prepare(
          `SELECT ${prefixColumns(CANDIDATE_COLUMNS, "memory_items")} FROM memory_items_fts ` +
            "JOIN memory_items ON memory_items.id = memory_items_fts.id " +
            `WHERE memory_items_fts MATCH ? AND ${conditions.join(" AND ")} ` +
            "ORDER BY bm25(memory_items_fts) LIMIT ?",
        )
        .all(...values) as MemoryItemRow[];
      for (const row of rows) {
        byId.set(row.id, rowToRecord(row));
      }
    }

    if (byId.size < options.limit) {
      const conditions = [
        "deleted_at IS NULL",
        "superseded_by IS NULL",
        "source <> 'workbuddy_document'",
      ];
      const values: Array<string | number> = [];
      appendScopeConditions(conditions, values, options.scopes);
      values.push(Math.min(16, options.limit));
      const rows = db
        .prepare(
          `SELECT ${CANDIDATE_COLUMNS} FROM memory_items WHERE ${conditions.join(" AND ")} ` +
            "ORDER BY updated_at DESC LIMIT ?",
        )
        .all(...values) as MemoryItemRow[];
      for (const row of rows) {
        if (byId.size >= options.limit) {
          break;
        }
        byId.set(row.id, rowToRecord(row));
      }
    }
    return [...byId.values()];
  }

  async softDelete(
    id: string,
    input: { deletedAt: string; deletedBy?: string; reason?: string },
  ): Promise<boolean> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(
          "UPDATE memory_items SET deleted_at = ?, deleted_by = ?, delete_reason = ?, updated_at = ? " +
            "WHERE id = ? AND deleted_at IS NULL",
        )
        .run(input.deletedAt, input.deletedBy ?? null, input.reason ?? null, input.deletedAt, id);
      db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(id);
      db.exec("COMMIT");
      return Number(result.changes ?? 0) > 0;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async restore(id: string, updatedAt: string): Promise<MemoryRecord | null> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(
          "UPDATE memory_items SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, " +
            "superseded_by = NULL, updated_at = ? WHERE id = ?",
        )
        .run(updatedAt, id);
      if (Number(result.changes ?? 0) === 0) {
        db.exec("COMMIT");
        return null;
      }
      const row = db
        .prepare(`SELECT ${MEMORY_COLUMNS} FROM memory_items WHERE id = ?`)
        .get(id) as MemoryItemRow;
      const record = rowToRecord(row);
      db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(id);
      if (isSearchVisible(record)) {
        prepareFtsInsert(db).run(...ftsValues(record));
      }
      db.exec("COMMIT");
      return record;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async supersede(id: string, winnerId: string, updatedAt: string): Promise<boolean> {
    using db = openSqliteDatabase(this.filePath);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare(
          "UPDATE memory_items SET superseded_by = ?, updated_at = ? " +
            "WHERE id = ? AND deleted_at IS NULL AND superseded_by IS NULL",
        )
        .run(winnerId, updatedAt, id);
      db.prepare("DELETE FROM memory_items_fts WHERE id = ?").run(id);
      db.exec("COMMIT");
      return Number(result.changes ?? 0) > 0;
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

  async get(id: string, options: MemoryGetOptions = {}): Promise<MemoryRecord | null> {
    const record = this.records.find((entry) => entry.id === id);
    if (!record || !isVisible(record, {
      ...options,
      includeDocuments: options.includeDocuments ?? true,
    })) {
      return null;
    }
    return cloneRecords([record])[0]!;
  }

  async getMany(ids: string[]): Promise<MemoryRecord[]> {
    const byId = new Map(this.records.filter((record) => isSearchVisible(record)).map((record) => [record.id, record]));
    return cloneRecords(ids.map((id) => byId.get(id)).filter((record): record is MemoryRecord => Boolean(record)));
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    const records = this.records
      .filter((record) => isVisible(record, options))
      .filter((record) => matchesScopes(record.scope, options.scopes))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return cloneRecords(options.limit && options.limit > 0 ? records.slice(0, options.limit) : records);
  }

  async findDedupeCandidates(scope: MemoryScope, kind: MemoryKind, limit = 64): Promise<MemoryRecord[]> {
    return cloneRecords(
      this.records
        .filter(isSearchVisible)
        .filter((record) => record.scope.type === scope.type && record.scope.id === scope.id && record.kind === kind)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, limit),
    ).map((record) => ({ ...record, metadata: undefined }));
  }

  async findSessionRecord(scope: MemoryScope, sessionId: string, taskId?: string): Promise<MemoryRecord | null> {
    const record = this.records.find((entry) => {
      if (!isSearchVisible(entry) || entry.scope.type !== scope.type || entry.scope.id !== scope.id) {
        return false;
      }
      if (entry.metadata?.sessionId !== sessionId) {
        return false;
      }
      return !taskId || entry.metadata?.taskId === taskId;
    });
    return record ? cloneRecords([record])[0]! : null;
  }

  async searchCandidates(query: string, options: MemoryStoreSearchOptions): Promise<MemoryRecord[]> {
    const queryTokens = uniqueTokens(query);
    return cloneRecords(
      this.records
        .filter(isSearchVisible)
        .filter((record) => matchesScopes(record.scope, options.scopes))
        .toSorted((left, right) => {
          const leftScore = tokenOverlapScore(queryTokens, uniqueTokens(searchText(left)));
          const rightScore = tokenOverlapScore(queryTokens, uniqueTokens(searchText(right)));
          return rightScore - leftScore || right.updatedAt.localeCompare(left.updatedAt);
        })
        .slice(0, options.limit),
    ).map((record) => ({ ...record, metadata: undefined }));
  }

  async softDelete(
    id: string,
    input: { deletedAt: string; deletedBy?: string; reason?: string },
  ): Promise<boolean> {
    const record = this.records.find((entry) => entry.id === id && !entry.deletedAt);
    if (!record) {
      return false;
    }
    record.deletedAt = input.deletedAt;
    record.deletedBy = input.deletedBy;
    record.deleteReason = input.reason;
    record.updatedAt = input.deletedAt;
    return true;
  }

  async restore(id: string, updatedAt: string): Promise<MemoryRecord | null> {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) {
      return null;
    }
    delete record.deletedAt;
    delete record.deletedBy;
    delete record.deleteReason;
    delete record.supersededBy;
    record.updatedAt = updatedAt;
    return cloneRecords([record])[0]!;
  }

  async supersede(id: string, winnerId: string, updatedAt: string): Promise<boolean> {
    const record = this.records.find((entry) => entry.id === id && !entry.deletedAt && !entry.supersededBy);
    if (!record) {
      return false;
    }
    record.supersededBy = winnerId;
    record.updatedAt = updatedAt;
    return true;
  }
}

function rowToRecord(row: MemoryItemRow): MemoryRecord {
  return {
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
    deletedAt: row.deleted_at ?? undefined,
    deletedBy: row.deleted_by ?? undefined,
    deleteReason: row.delete_reason ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
  };
}

function recordValues(record: MemoryRecord): Array<string | number | null> {
  return [
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
    record.deletedAt ?? null,
    record.deletedBy ?? null,
    record.deleteReason ?? null,
    record.supersededBy ?? null,
  ];
}

function ftsValues(record: MemoryRecord): string[] {
  return [
    record.id,
    record.kind,
    record.content,
    record.summary ?? "",
    record.tags.join(" "),
    `${record.scope.type}:${record.scope.id}`,
  ];
}

function prepareFtsInsert(db: ReturnType<typeof openSqliteDatabase>) {
  return db.prepare(
    "INSERT INTO memory_items_fts (id, kind, content, summary, tags, scope) VALUES (?, ?, ?, ?, ?, ?)",
  );
}

function isSearchVisible(record: MemoryRecord): boolean {
  return !record.deletedAt && !record.supersededBy && record.source !== "workbuddy_document";
}

function isVisible(record: MemoryRecord, options: MemoryGetOptions | MemoryListOptions): boolean {
  if (!options.includeDeleted && (record.deletedAt || record.supersededBy)) {
    return false;
  }
  if (!options.includeDocuments && record.source === "workbuddy_document") {
    return false;
  }
  return true;
}

function appendVisibilityConditions(
  conditions: string[],
  _values: Array<string | number>,
  options: MemoryGetOptions | MemoryListOptions,
  prefix?: string,
): void {
  const column = (name: string) => prefix ? `${prefix}.${name}` : name;
  if (!options.includeDeleted) {
    conditions.push(`${column("deleted_at")} IS NULL`, `${column("superseded_by")} IS NULL`);
  }
  if (!options.includeDocuments) {
    conditions.push(`${column("source")} <> 'workbuddy_document'`);
  }
}

function appendScopeConditions(
  conditions: string[],
  values: Array<string | number>,
  scopes?: MemoryScope[],
  prefix?: string,
): void {
  if (!scopes || scopes.length === 0) {
    return;
  }
  const column = (name: string) => prefix ? `${prefix}.${name}` : name;
  conditions.push(
    `(${scopes.map(() => `(${column("scope_type")} = ? AND ${column("scope_id")} = ?)`).join(" OR ")})`,
  );
  for (const scope of scopes) {
    values.push(scope.type, scope.id);
  }
}

function matchesScopes(scope: MemoryScope, scopes?: MemoryScope[]): boolean {
  return !scopes?.length || scopes.some((entry) => entry.type === scope.type && entry.id === scope.id);
}

function buildFtsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replaceAll("\"", "\"\"")}"`).join(" OR ");
}

function prefixColumns(columns: string, prefix: string): string {
  return columns
    .split(", ")
    .map((column) => {
      if (column === "NULL AS metadata_json") {
        return column;
      }
      return `${prefix}.${column}`;
    })
    .join(", ");
}

function searchText(record: MemoryRecord): string {
  return [record.kind, record.summary ?? "", record.content, record.tags.join(" "), record.scope.type, record.scope.id]
    .filter(Boolean)
    .join("\n");
}
