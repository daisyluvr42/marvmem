import type {
  CloudMemoryRecord,
  SyncState,
  SyncResult,
} from "./types.js";
import type { MemoryRecord, MemoryStore } from "../core/types.js";

// ---------------------------------------------------------------------------
// SyncTarget — abstraction over the remote store (Supabase, HTTP, etc.)
// ---------------------------------------------------------------------------

/**
 * Remote storage backend for cloud sync.
 * Implement this for Supabase, custom HTTP, or testing.
 */
export interface SyncTarget {
  /** Push records to remote. Returns new sync versions assigned. */
  push(records: CloudMemoryRecord[]): Promise<{ syncVersion: number }[]>;

  /** Pull records updated since the given sync version. */
  pullSince(
    projectId: string,
    sinceVersion: number,
    limit?: number,
  ): Promise<CloudMemoryRecord[]>;

  /** Get the highest sync version for a project. */
  getLatestVersion(projectId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// LocalStore — abstraction over the local store (SQLite, in-memory)
// ---------------------------------------------------------------------------

/**
 * Local storage interface for sync operations.
 * Maps to SQLite in production.
 */
export interface LocalSyncStore {
  /** Get records that haven't been synced (syncVersion === 0). */
  getUnsynced(projectId: string): Promise<CloudMemoryRecord[]>;

  /** Mark records as synced with the given version. */
  markSynced(ids: string[], syncVersion: number): Promise<void>;

  /** Upsert records from remote (pull). */
  upsertFromRemote(records: CloudMemoryRecord[]): Promise<number>;

  /** Get sync state. */
  getSyncState(projectId: string): Promise<SyncState>;

  /** Update sync state. */
  setSyncState(state: SyncState): Promise<void>;
}

// ---------------------------------------------------------------------------
// CloudSyncManager
// ---------------------------------------------------------------------------

export class CloudSyncManager {
  constructor(
    private readonly local: LocalSyncStore,
    private readonly remote: SyncTarget,
  ) {}

  /**
   * Push unsynced local records to remote.
   */
  async push(projectId: string): Promise<SyncResult> {
    const unsynced = await this.local.getUnsynced(projectId);

    if (unsynced.length === 0) {
      const state = await this.local.getSyncState(projectId);
      return {
        direction: "push",
        recordsProcessed: 0,
        newSyncVersion: state.lastSyncVersion,
        errors: [],
      };
    }

    const errors: string[] = [];
    let newVersion = 0;

    try {
      const results = await this.remote.push(unsynced);
      const ids = unsynced.map((r) => r.id);
      newVersion = Math.max(...results.map((r) => r.syncVersion));
      await this.local.markSynced(ids, newVersion);
    } catch (err) {
      errors.push(`Push failed: ${(err as Error).message}`);
    }

    // Update sync state
    const state = await this.local.getSyncState(projectId);
    await this.local.setSyncState({
      ...state,
      lastSyncVersion: Math.max(state.lastSyncVersion, newVersion),
      lastSyncAt: new Date().toISOString(),
      pendingPushCount: errors.length > 0 ? unsynced.length : 0,
    });

    return {
      direction: "push",
      recordsProcessed: errors.length > 0 ? 0 : unsynced.length,
      newSyncVersion: newVersion,
      errors,
    };
  }

  /**
   * Pull remote records that are newer than our last sync version.
   */
  async pull(projectId: string): Promise<SyncResult> {
    const state = await this.local.getSyncState(projectId);
    const errors: string[] = [];
    let processed = 0;
    let newVersion = state.lastSyncVersion;

    try {
      const remoteRecords = await this.remote.pullSince(
        projectId,
        state.lastSyncVersion,
      );

      if (remoteRecords.length > 0) {
        processed = await this.local.upsertFromRemote(remoteRecords);
        newVersion = Math.max(
          ...remoteRecords.map((r) => r.syncVersion),
        );
      }
    } catch (err) {
      errors.push(`Pull failed: ${(err as Error).message}`);
    }

    await this.local.setSyncState({
      ...state,
      lastSyncVersion: newVersion,
      lastSyncAt: new Date().toISOString(),
      pendingPushCount: state.pendingPushCount,
    });

    return {
      direction: "pull",
      recordsProcessed: processed,
      newSyncVersion: newVersion,
      errors,
    };
  }

  /**
   * Full sync: pull first (to get latest remote), then push local changes.
   * Pull-first avoids pushing stale data that would be overwritten.
   */
  async sync(projectId: string): Promise<{
    pull: SyncResult;
    push: SyncResult;
  }> {
    const pullResult = await this.pull(projectId);
    const pushResult = await this.push(projectId);
    return { pull: pullResult, push: pushResult };
  }

  /** Get current sync state for display/debugging. */
  async getState(projectId: string): Promise<SyncState> {
    return this.local.getSyncState(projectId);
  }
}

// ---------------------------------------------------------------------------
// InMemorySyncTarget — for testing
// ---------------------------------------------------------------------------

export class InMemorySyncTarget implements SyncTarget {
  private records: CloudMemoryRecord[] = [];
  private version = 0;

  async push(
    records: CloudMemoryRecord[],
  ): Promise<{ syncVersion: number }[]> {
    return records.map((r) => {
      this.version++;
      const existing = this.records.findIndex((e) => e.id === r.id);
      const record = { ...r, syncVersion: this.version };
      if (existing >= 0) {
        this.records[existing] = record;
      } else {
        this.records.push(record);
      }
      return { syncVersion: this.version };
    });
  }

  async pullSince(
    projectId: string,
    sinceVersion: number,
  ): Promise<CloudMemoryRecord[]> {
    return this.records.filter(
      (r) =>
        r.projectId === projectId && r.syncVersion > sinceVersion,
    );
  }

  async getLatestVersion(projectId: string): Promise<number> {
    const matching = this.records.filter(
      (r) => r.projectId === projectId,
    );
    if (matching.length === 0) return 0;
    return Math.max(...matching.map((r) => r.syncVersion));
  }

  /** Expose for testing */
  getAll(): CloudMemoryRecord[] {
    return [...this.records];
  }
}

// ---------------------------------------------------------------------------
// InMemoryLocalSyncStore — for testing
// ---------------------------------------------------------------------------

export class InMemoryLocalSyncStore implements LocalSyncStore {
  private records = new Map<string, CloudMemoryRecord>();
  private states = new Map<string, SyncState>();

  addRecord(record: CloudMemoryRecord): void {
    this.records.set(record.id, record);
  }

  async getUnsynced(projectId: string): Promise<CloudMemoryRecord[]> {
    return [...this.records.values()].filter(
      (r) => r.projectId === projectId && r.syncVersion === 0,
    );
  }

  async markSynced(ids: string[], syncVersion: number): Promise<void> {
    for (const id of ids) {
      const r = this.records.get(id);
      if (r) r.syncVersion = syncVersion;
    }
  }

  async upsertFromRemote(records: CloudMemoryRecord[]): Promise<number> {
    let count = 0;
    for (const r of records) {
      const existing = this.records.get(r.id);
      // Last-write-wins: only overwrite if remote is newer
      if (!existing || r.updatedAt >= existing.updatedAt) {
        this.records.set(r.id, { ...r });
        count++;
      }
    }
    return count;
  }

  async getSyncState(projectId: string): Promise<SyncState> {
    return (
      this.states.get(projectId) ?? {
        projectId,
        lastSyncVersion: 0,
        lastSyncAt: null,
        pendingPushCount: 0,
      }
    );
  }

  async setSyncState(state: SyncState): Promise<void> {
    this.states.set(state.projectId, state);
  }

  /** For testing */
  getRecord(id: string): CloudMemoryRecord | undefined {
    return this.records.get(id);
  }
}

export class MemoryStoreLocalSyncStore implements LocalSyncStore {
  private readonly states = new Map<string, SyncState>();

  constructor(private readonly store: MemoryStore) {}

  async getUnsynced(projectId: string): Promise<CloudMemoryRecord[]> {
    const records = await this.store.load();
    return records
      .filter((record) => belongsToProject(record, projectId))
      .filter((record) => readSyncVersion(record) === 0)
      .map((record) => toCloudRecord(record, projectId));
  }

  async markSynced(ids: string[], syncVersion: number): Promise<void> {
    const idSet = new Set(ids);
    const records = await this.store.load();
    for (const record of records) {
      if (idSet.has(record.id)) {
        record.metadata = { ...(record.metadata ?? {}), syncVersion };
      }
    }
    await this.store.save(records);
  }

  async upsertFromRemote(records: CloudMemoryRecord[]): Promise<number> {
    const local = await this.store.load();
    let processed = 0;
    for (const remote of records) {
      const index = local.findIndex((record) => record.id === remote.id);
      if (remote.deletedAt) {
        if (index >= 0) {
          local.splice(index, 1);
          processed++;
        }
        continue;
      }
      const next = fromCloudRecord(remote);
      if (index === -1) {
        local.push(next);
        processed++;
        continue;
      }
      if (remote.updatedAt >= local[index]!.updatedAt) {
        local[index] = next;
        processed++;
      }
    }
    if (processed > 0) {
      await this.store.save(local);
    }
    return processed;
  }

  async getSyncState(projectId: string): Promise<SyncState> {
    return (
      this.states.get(projectId) ?? {
        projectId,
        lastSyncVersion: 0,
        lastSyncAt: null,
        pendingPushCount: 0,
      }
    );
  }

  async setSyncState(state: SyncState): Promise<void> {
    this.states.set(state.projectId, state);
  }
}

function toCloudRecord(record: MemoryRecord, projectId: string): CloudMemoryRecord {
  return {
    id: record.id,
    projectId,
    scopeType: record.scope.type,
    scopeId: record.scope.id,
    kind: record.kind,
    content: record.content,
    summary: record.summary,
    confidence: record.confidence,
    importance: record.importance,
    source: record.source,
    tags: record.tags,
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deletedAt: null,
    syncVersion: readSyncVersion(record),
  };
}

function fromCloudRecord(record: CloudMemoryRecord): MemoryRecord {
  return {
    id: record.id,
    scope: {
      type: record.scopeType as MemoryRecord["scope"]["type"],
      id: record.scopeId,
    },
    kind: record.kind,
    content: record.content,
    summary: record.summary,
    confidence: record.confidence,
    importance: record.importance,
    source: record.source,
    tags: record.tags,
    metadata: { ...(record.metadata ?? {}), projectId: record.projectId, syncVersion: record.syncVersion },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function readSyncVersion(record: MemoryRecord): number {
  const value = record.metadata?.["syncVersion"];
  return typeof value === "number" ? value : 0;
}

function belongsToProject(record: MemoryRecord, projectId: string): boolean {
  if (record.metadata?.["projectId"] === projectId) {
    return true;
  }
  if (record.scope.type === "project" && record.scope.id === projectId) {
    return true;
  }
  return record.scope.type === "repo" && record.scope.id.startsWith(`${projectId}::`);
}
