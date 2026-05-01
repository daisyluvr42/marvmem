import type {
  MemoryRecallResult,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
} from "../core/types.js";
import type { MemoryCaptureResult } from "../runtime/types.js";

// ---------------------------------------------------------------------------
// Product-level context model
// ---------------------------------------------------------------------------

/**
 * The shared coordinate system across managed API, coding agent surface,
 * embedded runtime surface, bridge layer, and console.
 */
export type MemoryContext = {
  projectId: string;
  repoId?: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
};

/**
 * Result of resolving a MemoryContext into core-level scopes.
 *
 * `writeScope`  — the single primary scope used when persisting a durable record.
 * `recallScopes` — ordered scope list used for search and layered recall.
 */
export type ResolvedScopes = {
  writeScope: MemoryScope;
  recallScopes: MemoryScope[];
};

// ---------------------------------------------------------------------------
// Product-level memory kind additions
// ---------------------------------------------------------------------------

export const PRODUCT_MEMORY_KINDS = [
  "repo_convention",
  "workflow_rule",
  "task_state",
] as const;

export type ProductMemoryKind = (typeof PRODUCT_MEMORY_KINDS)[number];

// ---------------------------------------------------------------------------
// Platform service input / output types
// ---------------------------------------------------------------------------

export type CaptureTurnInput = {
  context: MemoryContext;
  userMessage: string;
  assistantMessage?: string;
  recentMessages?: string[];
  toolContext?: string;
  taskTitle?: string;
};

export type RecallInput = {
  context: MemoryContext;
  message: string;
  recentMessages?: string[];
  toolContext?: string;
  maxChars?: number;
  inspect?: boolean;
};

export type WriteMemoryInput = {
  context: MemoryContext;
  kind: string;
  content: string;
  summary?: string;
  confidence?: number;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type ListMemoriesInput = {
  context: MemoryContext;
  scopeTargets?: Array<"project" | "repo" | "user" | "agent" | "session" | "task">;
  kinds?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
};

export type MemoryRecordRef = {
  context: MemoryContext;
  id: string;
};

export type UpdateMemoryInput = {
  kind?: string;
  content?: string;
  summary?: string;
  confidence?: number;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Recall inspection
// ---------------------------------------------------------------------------

export type RecallInspection = {
  context: MemoryContext;
  message: string;
  injectedContext: string;
  layers?: {
    active?: string;
    task?: string;
    retrieval?: string;
    palace?: string;
  };
  hits?: MemorySearchHit[];
};

// ---------------------------------------------------------------------------
// Platform service contract
// ---------------------------------------------------------------------------

export interface PlatformMemoryService {
  resolveContextScopes(context: MemoryContext): ResolvedScopes;

  captureTurn(input: CaptureTurnInput): Promise<MemoryCaptureResult>;

  buildRecall(input: RecallInput): Promise<MemoryRecallResult>;

  inspectRecall(input: RecallInput): Promise<RecallInspection>;

  writeMemory(input: WriteMemoryInput): Promise<MemoryRecord>;

  listMemories(input: ListMemoriesInput): Promise<MemoryRecord[]>;

  getMemory(input: MemoryRecordRef): Promise<MemoryRecord | null>;

  updateMemory(input: {
    ref: MemoryRecordRef;
    patch: UpdateMemoryInput;
  }): Promise<MemoryRecord | null>;

  deleteMemory(input: MemoryRecordRef): Promise<boolean>;
}
