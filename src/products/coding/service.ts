import type { MemoryRecallResult, MemoryRecord } from "../../core/types.js";
import type {
  CaptureTurnInput,
  ListMemoriesInput,
  PlatformMemoryService,
  RecallInput,
} from "../../platform/types.js";
import type { MemoryCaptureResult } from "../../runtime/types.js";
import type { CodingMemoryService } from "./types.js";
import { extractCodingProposals } from "./extraction.js";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type CodingMemoryServiceOptions = {
  platform: PlatformMemoryService;
};

export class MarvMemCodingService implements CodingMemoryService {
  private readonly platform: PlatformMemoryService;

  constructor(options: CodingMemoryServiceOptions) {
    this.platform = options.platform;
  }

  async captureCodingTurn(input: CaptureTurnInput): Promise<MemoryCaptureResult> {
    if (!input.context.projectId) {
      throw new Error("CodingMemoryService requires projectId");
    }

    // Run standard capture through platform
    const result = await this.platform.captureTurn(input);

    // Run coding-specific extraction and write additional memories
    const codingProposals = extractCodingProposals({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
    });

    for (const proposal of codingProposals) {
      // Avoid duplicating if platform already captured something similar
      const isDuplicate = result.stored.some(
        (r) => r.content.trim().toLowerCase() === proposal.content.trim().toLowerCase(),
      );
      if (isDuplicate) continue;

      const record = await this.platform.writeMemory({
        context: input.context,
        kind: proposal.kind,
        content: proposal.content,
        summary: proposal.summary,
        confidence: proposal.confidence,
        importance: proposal.importance,
        source: proposal.source,
        tags: proposal.tags,
      });
      result.stored.push(record);
      result.proposals.push(proposal);
    }

    return result;
  }

  async buildCodingRecall(input: RecallInput): Promise<MemoryRecallResult> {
    if (!input.context.projectId) {
      throw new Error("CodingMemoryService requires projectId");
    }

    return this.platform.buildRecall(input);
  }

  async listRepoMemories(input: ListMemoriesInput): Promise<MemoryRecord[]> {
    if (!input.context.projectId) {
      throw new Error("CodingMemoryService requires projectId");
    }

    // Force scope targets to repo + project for coding context
    return this.platform.listMemories({
      ...input,
      scopeTargets: input.scopeTargets ?? ["repo", "project"],
    });
  }
}

export function createCodingMemoryService(
  options: CodingMemoryServiceOptions,
): CodingMemoryService {
  return new MarvMemCodingService(options);
}
