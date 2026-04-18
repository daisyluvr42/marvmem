import { DatabaseSync } from "node:sqlite";
import { normalizeScope, scopeKey, type MemoryScope } from "../core/types.js";
import { openSqliteDatabase, parseJsonObject } from "../system/sqlite.js";
import type {
  TaskBookmark,
  TaskBookmarkKind,
  TaskContextEntry,
  TaskContextRecord,
  TaskContextState,
  TaskContextStore,
} from "./types.js";

type TaskRow = {
  task_id: string;
  scope_type: string;
  scope_id: string;
  title: string;
  status: string;
  created_at: number;
  updated_at: number;
};

type TaskEntryRow = {
  id: string;
  task_id: string;
  sequence: number;
  role: string;
  content: string;
  summary: string | null;
  token_count: number;
  created_at: number;
  metadata_json: string | null;
  summarized: number;
};

type TaskStateRow = {
  task_id: string;
  rolling_summary: string | null;
  updated_at: number;
};

type TaskBookmarkRow = {
  id: string;
  task_id: string;
  kind: string;
  content: string;
  created_at: number;
  metadata_json: string | null;
};

export class SqliteTaskContextStore implements TaskContextStore {
  constructor(private readonly filePath: string) {}

  async getTask(taskId: string): Promise<TaskContextRecord | null> {
    const db = openSqliteDatabase(this.filePath);
    try {
      const row = db
        .prepare(
          "SELECT task_id, scope_type, scope_id, title, status, created_at, updated_at " +
            "FROM task_context WHERE task_id = ?",
        )
        .get(taskId) as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    } finally {
      db.close();
    }
  }

  async upsertTask(task: TaskContextRecord): Promise<TaskContextRecord> {
    const db = openSqliteDatabase(this.filePath);
    try {
      const scope = normalizeScope(task.scope);
      db.prepare(
        "INSERT INTO task_context (" +
          "task_id, scope_type, scope_id, title, status, created_at, updated_at" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(task_id) DO UPDATE SET " +
          "scope_type = excluded.scope_type, scope_id = excluded.scope_id, title = excluded.title, " +
          "status = excluded.status, updated_at = excluded.updated_at",
      ).run(
        task.taskId,
        scope.type,
        scope.id,
        task.title,
        task.status,
        task.createdAt,
        task.updatedAt,
      );
      return {
        ...task,
        scope,
      };
    } finally {
      db.close();
    }
  }

  async listTasks(scope?: MemoryScope): Promise<TaskContextRecord[]> {
    const db = openSqliteDatabase(this.filePath);
    try {
      let rows: TaskRow[];
      if (scope) {
        const normalized = normalizeScope(scope);
        rows = db
          .prepare(
            "SELECT task_id, scope_type, scope_id, title, status, created_at, updated_at " +
              "FROM task_context WHERE scope_type = ? AND scope_id = ? " +
              "ORDER BY updated_at DESC, created_at DESC",
          )
          .all(normalized.type, normalized.id) as TaskRow[];
      } else {
        rows = db
          .prepare(
            "SELECT task_id, scope_type, scope_id, title, status, created_at, updated_at " +
              "FROM task_context ORDER BY updated_at DESC, created_at DESC",
          )
          .all() as TaskRow[];
      }
      return rows.map(rowToTask);
    } finally {
      db.close();
    }
  }

  async appendEntry(
    entry: Omit<TaskContextEntry, "sequence"> & { sequence?: number },
  ): Promise<TaskContextEntry> {
    const db = openSqliteDatabase(this.filePath);
    try {
      const sequence =
        entry.sequence ??
        Number(
          (
            db.prepare("SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM task_context_entries WHERE task_id = ?")
              .get(entry.taskId) as { max_sequence?: number } | undefined
          )?.max_sequence ?? 0,
        ) +
          1;
      db.prepare(
        "INSERT INTO task_context_entries (" +
          "id, task_id, sequence, role, content, summary, token_count, created_at, metadata_json, summarized" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        entry.id,
        entry.taskId,
        sequence,
        entry.role,
        entry.content,
        entry.summary ?? null,
        entry.tokenCount,
        entry.createdAt,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.summarized ? 1 : 0,
      );
      touchTaskContext(db, entry.taskId, entry.createdAt);
      return {
        ...entry,
        sequence,
      };
    } finally {
      db.close();
    }
  }

  async listEntries(
    taskId: string,
    options: { limit?: number; summarized?: boolean } = {},
  ): Promise<TaskContextEntry[]> {
    const db = openSqliteDatabase(this.filePath);
    try {
      const limit = Math.max(1, Math.floor(options.limit ?? 200));
      let rows: TaskEntryRow[];
      if (options.summarized === undefined) {
        rows = db
          .prepare(
            "SELECT id, task_id, sequence, role, content, summary, token_count, created_at, metadata_json, summarized " +
              "FROM task_context_entries WHERE task_id = ? ORDER BY sequence ASC LIMIT ?",
          )
          .all(taskId, limit) as TaskEntryRow[];
      } else {
        rows = db
          .prepare(
            "SELECT id, task_id, sequence, role, content, summary, token_count, created_at, metadata_json, summarized " +
              "FROM task_context_entries WHERE task_id = ? AND summarized = ? " +
              "ORDER BY sequence ASC LIMIT ?",
          )
          .all(taskId, options.summarized ? 1 : 0, limit) as TaskEntryRow[];
      }
      return rows.map(rowToEntry);
    } finally {
      db.close();
    }
  }

  async markEntriesSummarized(taskId: string, entryIds: string[], summary: string): Promise<number> {
    const ids = dedupeIds(entryIds);
    if (ids.length === 0) {
      return 0;
    }
    const db = openSqliteDatabase(this.filePath);
    try {
      const stmt = db.prepare(
        "UPDATE task_context_entries SET summarized = 1, summary = ? WHERE task_id = ? AND id = ?",
      );
      let updated = 0;
      for (const id of ids) {
        stmt.run(summary, taskId, id);
        updated += readChanges(db);
      }
      return updated;
    } finally {
      db.close();
    }
  }

  async getState(taskId: string): Promise<TaskContextState | null> {
    const db = openSqliteDatabase(this.filePath);
    try {
      const row = db
        .prepare(
          "SELECT task_id, rolling_summary, updated_at FROM task_context_state WHERE task_id = ?",
        )
        .get(taskId) as TaskStateRow | undefined;
      return row ? rowToState(row) : null;
    } finally {
      db.close();
    }
  }

  async putState(state: TaskContextState): Promise<TaskContextState> {
    const db = openSqliteDatabase(this.filePath);
    try {
      db.prepare(
        "INSERT INTO task_context_state (task_id, rolling_summary, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(task_id) DO UPDATE SET rolling_summary = excluded.rolling_summary, updated_at = excluded.updated_at",
      ).run(state.taskId, state.rollingSummary ?? null, state.updatedAt);
      touchTaskContext(db, state.taskId, state.updatedAt);
      return state;
    } finally {
      db.close();
    }
  }

  async putBookmark(bookmark: TaskBookmark): Promise<TaskBookmark> {
    const db = openSqliteDatabase(this.filePath);
    try {
      db.prepare(
        "INSERT INTO task_context_bookmarks (id, task_id, kind, content, created_at, metadata_json) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        bookmark.id,
        bookmark.taskId,
        bookmark.kind,
        bookmark.content,
        bookmark.createdAt,
        bookmark.metadata ? JSON.stringify(bookmark.metadata) : null,
      );
      touchTaskContext(db, bookmark.taskId, bookmark.createdAt);
      return bookmark;
    } finally {
      db.close();
    }
  }

  async listBookmarks(taskId: string, kind?: TaskBookmarkKind): Promise<TaskBookmark[]> {
    const db = openSqliteDatabase(this.filePath);
    try {
      const rows = kind
        ? (db
            .prepare(
              "SELECT id, task_id, kind, content, created_at, metadata_json " +
                "FROM task_context_bookmarks WHERE task_id = ? AND kind = ? " +
                "ORDER BY created_at DESC",
            )
            .all(taskId, kind) as TaskBookmarkRow[])
        : (db
            .prepare(
              "SELECT id, task_id, kind, content, created_at, metadata_json " +
                "FROM task_context_bookmarks WHERE task_id = ? ORDER BY created_at DESC",
            )
            .all(taskId) as TaskBookmarkRow[]);
      return rows.map(rowToBookmark);
    } finally {
      db.close();
    }
  }
}

export class InMemoryTaskContextStore implements TaskContextStore {
  private readonly tasks = new Map<string, TaskContextRecord>();
  private readonly entries = new Map<string, TaskContextEntry[]>();
  private readonly states = new Map<string, TaskContextState>();
  private readonly bookmarks = new Map<string, TaskBookmark[]>();

  async getTask(taskId: string): Promise<TaskContextRecord | null> {
    return cloneTask(this.tasks.get(taskId) ?? null);
  }

  async upsertTask(task: TaskContextRecord): Promise<TaskContextRecord> {
    const normalized: TaskContextRecord = {
      ...task,
      scope: normalizeScope(task.scope),
    };
    this.tasks.set(normalized.taskId, normalized);
    return cloneTask(normalized)!;
  }

  async listTasks(scope?: MemoryScope): Promise<TaskContextRecord[]> {
    const normalizedKey = scope ? scopeKey(normalizeScope(scope)) : null;
    return [...this.tasks.values()]
      .filter((task) => (normalizedKey ? scopeKey(task.scope) === normalizedKey : true))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .map((task) => cloneTask(task)!)
      .filter(Boolean);
  }

  async appendEntry(
    entry: Omit<TaskContextEntry, "sequence"> & { sequence?: number },
  ): Promise<TaskContextEntry> {
    const existing = this.entries.get(entry.taskId) ?? [];
    const stored: TaskContextEntry = {
      ...entry,
      sequence: entry.sequence ?? existing.length + 1,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    };
    existing.push(stored);
    this.entries.set(entry.taskId, existing);
    const task = this.tasks.get(entry.taskId);
    if (task) {
      task.updatedAt = entry.createdAt;
    }
    return cloneEntry(stored);
  }

  async listEntries(
    taskId: string,
    options: { limit?: number; summarized?: boolean } = {},
  ): Promise<TaskContextEntry[]> {
    return (this.entries.get(taskId) ?? [])
      .filter((entry) =>
        options.summarized === undefined ? true : entry.summarized === options.summarized,
      )
      .slice(0, Math.max(1, Math.floor(options.limit ?? 200)))
      .map(cloneEntry);
  }

  async markEntriesSummarized(taskId: string, entryIds: string[], summary: string): Promise<number> {
    const ids = new Set(dedupeIds(entryIds));
    let updated = 0;
    for (const entry of this.entries.get(taskId) ?? []) {
      if (!ids.has(entry.id)) {
        continue;
      }
      entry.summarized = true;
      entry.summary = summary;
      updated += 1;
    }
    return updated;
  }

  async getState(taskId: string): Promise<TaskContextState | null> {
    const state = this.states.get(taskId);
    return state ? { ...state } : null;
  }

  async putState(state: TaskContextState): Promise<TaskContextState> {
    const stored = { ...state };
    this.states.set(state.taskId, stored);
    const task = this.tasks.get(state.taskId);
    if (task) {
      task.updatedAt = state.updatedAt;
    }
    return { ...stored };
  }

  async putBookmark(bookmark: TaskBookmark): Promise<TaskBookmark> {
    const stored = {
      ...bookmark,
      metadata: bookmark.metadata ? { ...bookmark.metadata } : undefined,
    };
    const existing = this.bookmarks.get(bookmark.taskId) ?? [];
    existing.unshift(stored);
    this.bookmarks.set(bookmark.taskId, existing);
    const task = this.tasks.get(bookmark.taskId);
    if (task) {
      task.updatedAt = bookmark.createdAt;
    }
    return cloneBookmark(stored);
  }

  async listBookmarks(taskId: string, kind?: TaskBookmarkKind): Promise<TaskBookmark[]> {
    return (this.bookmarks.get(taskId) ?? [])
      .filter((bookmark) => (kind ? bookmark.kind === kind : true))
      .map(cloneBookmark);
  }
}

function touchTaskContext(db: DatabaseSync, taskId: string, updatedAt: number): void {
  db.prepare("UPDATE task_context SET updated_at = ? WHERE task_id = ?").run(updatedAt, taskId);
}

function readChanges(db: DatabaseSync): number {
  const row = db.prepare("SELECT changes() AS changes").get() as { changes?: number } | undefined;
  return Number(row?.changes ?? 0);
}

function rowToTask(row: TaskRow): TaskContextRecord {
  return {
    taskId: row.task_id,
    scope: { type: row.scope_type as MemoryScope["type"], id: row.scope_id },
    title: row.title,
    status: normalizeTaskStatus(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToEntry(row: TaskEntryRow): TaskContextEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: Number(row.sequence),
    role: normalizeTaskRole(row.role),
    content: row.content,
    summary: row.summary ?? undefined,
    tokenCount: Number(row.token_count),
    createdAt: Number(row.created_at),
    metadata: parseJsonObject(row.metadata_json),
    summarized: Number(row.summarized) > 0,
  };
}

function rowToState(row: TaskStateRow): TaskContextState {
  return {
    taskId: row.task_id,
    rollingSummary: row.rolling_summary ?? undefined,
    updatedAt: Number(row.updated_at),
  };
}

function rowToBookmark(row: TaskBookmarkRow): TaskBookmark {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind as TaskBookmarkKind,
    content: row.content,
    createdAt: Number(row.created_at),
    metadata: parseJsonObject(row.metadata_json),
  };
}

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

function normalizeTaskRole(value: string): TaskContextEntry["role"] {
  if (value === "user" || value === "assistant" || value === "system" || value === "tool") {
    return value;
  }
  return "assistant";
}

function normalizeTaskStatus(value: string): TaskContextRecord["status"] {
  if (
    value === "active" ||
    value === "paused" ||
    value === "completed" ||
    value === "archived"
  ) {
    return value;
  }
  return "active";
}

function cloneTask(task: TaskContextRecord | null): TaskContextRecord | null {
  return task
    ? {
        ...task,
        scope: { ...task.scope },
      }
    : null;
}

function cloneEntry(entry: TaskContextEntry): TaskContextEntry {
  return {
    ...entry,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  };
}

function cloneBookmark(bookmark: TaskBookmark): TaskBookmark {
  return {
    ...bookmark,
    metadata: bookmark.metadata ? { ...bookmark.metadata } : undefined,
  };
}
