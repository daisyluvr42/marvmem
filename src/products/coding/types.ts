import type { MemoryRecallResult, MemoryRecord } from "../../core/types.js";
import type {
  CaptureTurnInput,
  ListMemoriesInput,
  RecallInput,
} from "../../platform/types.js";
import type { MemoryCaptureResult } from "../../runtime/types.js";

// ---------------------------------------------------------------------------
// Coding-specific types
// ---------------------------------------------------------------------------

/**
 * Memory kinds biased toward in coding agent extraction.
 */
export const CODING_EXTRACTION_KINDS = [
  "repo_convention",
  "workflow_rule",
  "decision",
  "preference",
] as const;

export type CodingExtractionKind = (typeof CODING_EXTRACTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Coding memory service interface
// ---------------------------------------------------------------------------

export interface CodingMemoryService {
  /**
   * Capture a coding turn with extraction biased toward repo conventions
   * and workflow rules.
   */
  captureCodingTurn(input: CaptureTurnInput): Promise<MemoryCaptureResult>;

  /**
   * Build recall context biased toward repo-scoped memory.
   */
  buildCodingRecall(input: RecallInput): Promise<MemoryRecallResult>;

  /**
   * List memories for a repo scope.
   */
  listRepoMemories(input: ListMemoriesInput): Promise<MemoryRecord[]>;
}
