import type { TaskContextEntry } from "../task/types.js";
import type { MemoryInput, MemoryRecallResult, MemoryRecord, MemoryScope } from "../core/types.js";

export type MemoryTurnInput = {
  userMessage: string;
  assistantMessage?: string;
  recentMessages?: string[];
  scopes?: MemoryScope[];
  proposals?: CapturedMemoryProposal[];
  maxChars?: number;
  taskId?: string;
  taskTitle?: string;
  toolContext?: string;
};

export type CapturedMemoryProposal = Omit<MemoryInput, "scope"> & {
  scopes?: MemoryScope[];
};

export type MemoryProposalExtractorInput = Omit<MemoryTurnInput, "proposals" | "maxChars">;

export interface MemoryProposalExtractor {
  extract(input: MemoryProposalExtractorInput): Promise<CapturedMemoryProposal[]>;
}

export type MemoryCaptureResult = {
  proposals: CapturedMemoryProposal[];
  stored: MemoryRecord[];
  taskEntries?: TaskContextEntry[];
};

export type MemoryRuntimeOptions = {
  defaultScopes?: MemoryScope[];
  maxRecallChars?: number;
};

export interface MemoryRuntime {
  buildRecallContext(turn: MemoryTurnInput): Promise<MemoryRecallResult>;
  captureTurn(turn: MemoryTurnInput): Promise<MemoryCaptureResult>;
  captureReflection(input: {
    summary: string;
    scopes?: MemoryScope[];
    tags?: string[];
    metadata?: Record<string, unknown>;
    taskId?: string;
  }): Promise<MemoryRecord | null>;
  buildSystemHint(): string;
}
