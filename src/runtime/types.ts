import type { MemoryInput, MemoryRecallResult, MemoryRecord, MemoryScope } from "../core/types.js";

export type MemoryTurnInput = {
  userMessage: string;
  assistantMessage?: string;
  recentMessages?: string[];
  scopes?: MemoryScope[];
  maxChars?: number;
};

export type CapturedMemoryProposal = Omit<MemoryInput, "scope"> & {
  scopes?: MemoryScope[];
};

export type MemoryCaptureResult = {
  proposals: CapturedMemoryProposal[];
  stored: MemoryRecord[];
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
  }): Promise<MemoryRecord | null>;
  buildSystemHint(): string;
}
