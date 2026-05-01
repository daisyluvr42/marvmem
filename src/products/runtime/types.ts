import type { MemoryRecallResult, MemoryRecord } from "../../core/types.js";
import type {
  CaptureTurnInput,
  MemoryContext,
  RecallInput,
} from "../../platform/types.js";
import type { MemoryCaptureResult } from "../../runtime/types.js";
import type { ProjectionSyncInput, ProjectionSyncResult } from "../../bridge/base.js";

// ---------------------------------------------------------------------------
// Runtime memory service interface
// ---------------------------------------------------------------------------

export interface RuntimeMemoryService {
  /**
   * Build recall context for injection before the agent's prompt.
   */
  beforePrompt(input: RecallInput): Promise<MemoryRecallResult>;

  /**
   * Capture memory from a completed agent turn.
   */
  afterTurn(input: CaptureTurnInput): Promise<MemoryCaptureResult>;

  /**
   * Capture a runtime reflection (agent self-summary).
   */
  captureRuntimeReflection(input: {
    context: MemoryContext;
    summary: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryRecord | null>;

  /**
   * Sync runtime memory through a bridge adapter.
   */
  syncRuntimeMemory(input: ProjectionSyncInput): Promise<ProjectionSyncResult>;
}
