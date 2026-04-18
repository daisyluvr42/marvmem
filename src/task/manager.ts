import { randomUUID } from "node:crypto";
import { normalizeScope, type MemoryScope } from "../core/types.js";
import type { MemoryInferencerResult } from "../system/types.js";
import type {
  TaskBookmark,
  TaskContextEntry,
  TaskContextManagerOptions,
  TaskContextRecord,
  TaskContextRole,
  TaskContextState,
  TaskContextWindow,
  TaskStatus,
} from "./types.js";

const DEFAULT_RECENT_ENTRIES_LIMIT = 24;
const DEFAULT_WINDOW_MAX_CHARS = 4_000;
const DEFAULT_SUMMARY_MAX_CHARS = 600;

export class TaskContextManager {
  private readonly now: () => Date;
  private readonly recentEntriesLimit: number;
  private readonly windowMaxChars: number;
  private readonly summaryMaxChars: number;

  constructor(private readonly options: TaskContextManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.recentEntriesLimit = options.recentEntriesLimit ?? DEFAULT_RECENT_ENTRIES_LIMIT;
    this.windowMaxChars = options.windowMaxChars ?? DEFAULT_WINDOW_MAX_CHARS;
    this.summaryMaxChars = options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  }

  async create(input: {
    taskId: string;
    scope: MemoryScope;
    title: string;
    status?: TaskStatus;
  }): Promise<TaskContextRecord> {
    const now = this.now().getTime();
    return await this.options.store.upsertTask({
      taskId: input.taskId.trim(),
      scope: normalizeScope(input.scope),
      title: input.title.trim() || input.taskId.trim(),
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(taskId: string): Promise<TaskContextRecord | null> {
    return await this.options.store.getTask(taskId.trim());
  }

  async list(scope?: MemoryScope): Promise<TaskContextRecord[]> {
    return await this.options.store.listTasks(scope ? normalizeScope(scope) : undefined);
  }

  async appendEntry(input: {
    taskId: string;
    role: TaskContextRole;
    content: string;
    summary?: string;
    tokenCount?: number;
    metadata?: Record<string, unknown>;
  }): Promise<TaskContextEntry | null> {
    const taskId = input.taskId.trim();
    const content = input.content.trim();
    if (!taskId || !content) {
      return null;
    }
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      return null;
    }
    const createdAt = this.now().getTime();
    return await this.options.store.appendEntry({
      id: randomUUID(),
      taskId,
      role: input.role,
      content,
      summary: input.summary?.trim() || undefined,
      tokenCount: input.tokenCount ?? estimateTokenCount(content),
      createdAt,
      metadata: input.metadata,
      summarized: false,
    });
  }

  async listEntries(taskId: string, options?: { limit?: number; summarized?: boolean }) {
    return await this.options.store.listEntries(taskId.trim(), options);
  }

  async getRollingSummary(taskId: string): Promise<TaskContextState | null> {
    return await this.options.store.getState(taskId.trim());
  }

  async setRollingSummary(taskId: string, summary: string): Promise<TaskContextState | null> {
    const normalizedTaskId = taskId.trim();
    const content = summary.trim();
    if (!normalizedTaskId || !content) {
      return null;
    }
    return await this.options.store.putState({
      taskId: normalizedTaskId,
      rollingSummary: content,
      updatedAt: this.now().getTime(),
    });
  }

  async distillRollingSummary(input: {
    taskId: string;
    maxChars?: number;
    limit?: number;
  }): Promise<TaskContextState | null> {
    const taskId = input.taskId.trim();
    if (!taskId) {
      return null;
    }
    const pending = await this.options.store.listEntries(taskId, {
      limit: input.limit ?? 48,
      summarized: false,
    });
    if (pending.length === 0) {
      return await this.options.store.getState(taskId);
    }
    const current = await this.options.store.getState(taskId);
    const maxChars = input.maxChars ?? this.summaryMaxChars;
    const fallback = clampChars(
      [
        current?.rollingSummary?.trim(),
        ...pending.map((entry) => entry.summary?.trim() || entry.content.trim()),
      ]
        .filter(Boolean)
        .join("\n"),
      maxChars,
    );
    const result = await this.infer({
      kind: "task_summary",
      system:
        "Summarize the task state into a compact rolling summary. Keep durable progress, current plan, pending work, and blockers.",
      prompt: buildSummaryPrompt(current?.rollingSummary, pending),
      currentContent: current?.rollingSummary,
      maxChars,
    });
    const stored = await this.options.store.putState({
      taskId,
      rollingSummary: result.ok ? clampChars(result.text, maxChars) : fallback,
      updatedAt: this.now().getTime(),
    });
    await this.options.store.markEntriesSummarized(taskId, pending.map((entry) => entry.id), stored.rollingSummary ?? "");
    return stored;
  }

  async addDecision(input: {
    taskId: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<TaskBookmark | null> {
    const taskId = input.taskId.trim();
    const content = input.content.trim();
    if (!taskId || !content) {
      return null;
    }
    return await this.options.store.putBookmark({
      id: randomUUID(),
      taskId,
      kind: "decision",
      content,
      createdAt: this.now().getTime(),
      metadata: input.metadata,
    });
  }

  async listDecisions(taskId: string): Promise<TaskBookmark[]> {
    return await this.options.store.listBookmarks(taskId.trim(), "decision");
  }

  async buildWindow(input: {
    taskId: string;
    currentQuery: string;
    toolContext?: string;
    maxChars?: number;
    recentEntriesLimit?: number;
  }): Promise<TaskContextWindow> {
    const taskId = input.taskId.trim();
    const task = taskId ? await this.options.store.getTask(taskId) : null;
    const state = taskId ? await this.options.store.getState(taskId) : null;
    const decisions = taskId ? await this.options.store.listBookmarks(taskId, "decision") : [];
    const recentEntries = taskId
      ? await this.options.store.listEntries(taskId, {
          limit: input.recentEntriesLimit ?? this.recentEntriesLimit,
        })
      : [];
    const budget = Math.max(500, Math.floor(input.maxChars ?? this.windowMaxChars));
    const sections = [
      state?.rollingSummary?.trim()
        ? `Task summary:\n${state.rollingSummary.trim()}`
        : "",
      decisions.length > 0
        ? `Key decisions:\n${decisions
            .slice(0, 12)
            .map((bookmark) => `- ${bookmark.content.trim()}`)
            .join("\n")}`
        : "",
      recentEntries.length > 0
        ? `Recent task entries:\n${recentEntries
            .slice(-Math.max(1, input.recentEntriesLimit ?? this.recentEntriesLimit))
            .map((entry) => `${entry.role}: ${entry.content.trim()}`)
            .join("\n")}`
        : "",
      input.currentQuery.trim() ? `Current query:\n${input.currentQuery.trim()}` : "",
      input.toolContext?.trim() ? `Tool context:\n${input.toolContext.trim()}` : "",
    ].filter(Boolean);
    const injectedContext = clampChars(sections.join("\n\n"), budget);
    return {
      task,
      layers: {
        rollingSummary: state?.rollingSummary?.trim() || undefined,
        keyDecisions: decisions.slice(0, 12).map((bookmark) => bookmark.content.trim()),
        recentEntries: recentEntries.slice(-Math.max(1, input.recentEntriesLimit ?? this.recentEntriesLimit)),
        currentQuery: input.currentQuery.trim(),
        toolContext: input.toolContext?.trim() || undefined,
      },
      injectedContext,
      charUsage: {
        rollingSummary: state?.rollingSummary?.trim().length ?? 0,
        keyDecisions: decisions.reduce((sum, bookmark) => sum + bookmark.content.trim().length, 0),
        recentEntries: recentEntries.reduce((sum, entry) => sum + entry.content.trim().length, 0),
        currentQuery: input.currentQuery.trim().length,
        toolContext: input.toolContext?.trim().length ?? 0,
        total: injectedContext.length,
        budget,
      },
    };
  }

  private async infer(input: {
    kind: "task_summary";
    system: string;
    prompt: string;
    maxChars: number;
    currentContent?: string;
  }): Promise<MemoryInferencerResult> {
    if (!this.options.inferencer) {
      return { ok: false, error: "No inferencer configured" };
    }
    return await this.options.inferencer({
      kind: input.kind,
      system: input.system,
      prompt: input.prompt,
      maxChars: input.maxChars,
      currentContent: input.currentContent,
    });
  }
}

function buildSummaryPrompt(currentSummary: string | undefined, entries: TaskContextEntry[]): string {
  return [
    "## Current rolling summary",
    currentSummary?.trim() || "(empty)",
    "",
    "## New task entries",
    entries.map((entry) => `${entry.role}: ${entry.content.trim()}`).join("\n"),
  ].join("\n");
}

function clampChars(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars).trimEnd();
}

function estimateTokenCount(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}
