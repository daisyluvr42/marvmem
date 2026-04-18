import type { MemoryInferencer } from "../system/types.js";
import type { MemoryScope } from "../core/types.js";

export type TaskContextRole = "user" | "assistant" | "system" | "tool";
export type TaskStatus = "active" | "paused" | "completed" | "archived";
export type TaskBookmarkKind = "decision";

export type TaskContextRecord = {
  taskId: string;
  scope: MemoryScope;
  title: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
};

export type TaskContextEntry = {
  id: string;
  taskId: string;
  sequence: number;
  role: TaskContextRole;
  content: string;
  summary?: string;
  tokenCount: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
  summarized: boolean;
};

export type TaskContextState = {
  taskId: string;
  rollingSummary?: string;
  updatedAt: number;
};

export type TaskBookmark = {
  id: string;
  taskId: string;
  kind: TaskBookmarkKind;
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};

export type TaskContextWindow = {
  task: TaskContextRecord | null;
  layers: {
    rollingSummary?: string;
    keyDecisions: string[];
    recentEntries: TaskContextEntry[];
    currentQuery: string;
    toolContext?: string;
  };
  injectedContext: string;
  charUsage: {
    rollingSummary: number;
    keyDecisions: number;
    recentEntries: number;
    currentQuery: number;
    toolContext: number;
    total: number;
    budget: number;
  };
};

export type TaskContextStore = {
  getTask(taskId: string): Promise<TaskContextRecord | null>;
  upsertTask(task: TaskContextRecord): Promise<TaskContextRecord>;
  listTasks(scope?: MemoryScope): Promise<TaskContextRecord[]>;
  appendEntry(
    entry: Omit<TaskContextEntry, "sequence"> & { sequence?: number },
  ): Promise<TaskContextEntry>;
  listEntries(taskId: string, options?: { limit?: number; summarized?: boolean }): Promise<TaskContextEntry[]>;
  markEntriesSummarized(taskId: string, entryIds: string[], summary: string): Promise<number>;
  getState(taskId: string): Promise<TaskContextState | null>;
  putState(state: TaskContextState): Promise<TaskContextState>;
  putBookmark(bookmark: TaskBookmark): Promise<TaskBookmark>;
  listBookmarks(taskId: string, kind?: TaskBookmarkKind): Promise<TaskBookmark[]>;
};

export type TaskContextManagerOptions = {
  store: TaskContextStore;
  inferencer?: MemoryInferencer;
  now?: () => Date;
  recentEntriesLimit?: number;
  windowMaxChars?: number;
  summaryMaxChars?: number;
};
