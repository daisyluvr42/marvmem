import type { MemoryRecallResult, MemoryRecord } from "../../core/types.js";
import type {
  CaptureTurnInput,
  MemoryContext,
  PlatformMemoryService,
  RecallInput,
} from "../../platform/types.js";
import type { MemoryCaptureResult } from "../../runtime/types.js";
import type { BridgeAdapter, ProjectionSyncInput, ProjectionSyncResult } from "../../bridge/base.js";
import type { RuntimeMemoryService } from "./types.js";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type RuntimeMemoryServiceOptions = {
  platform: PlatformMemoryService;
  bridge?: BridgeAdapter;
};

export class MarvMemRuntimeService implements RuntimeMemoryService {
  private readonly platform: PlatformMemoryService;
  private readonly bridge?: BridgeAdapter;

  constructor(options: RuntimeMemoryServiceOptions) {
    this.platform = options.platform;
    this.bridge = options.bridge;
  }

  async beforePrompt(input: RecallInput): Promise<MemoryRecallResult> {
    return this.platform.buildRecall(input);
  }

  async afterTurn(input: CaptureTurnInput): Promise<MemoryCaptureResult> {
    return this.platform.captureTurn(input);
  }

  async captureRuntimeReflection(input: {
    context: MemoryContext;
    summary: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<MemoryRecord | null> {
    if (!input.summary.trim()) {
      return null;
    }

    return this.platform.writeMemory({
      context: input.context,
      kind: "experience",
      content: input.summary.trim(),
      summary: input.summary.trim(),
      confidence: 0.7,
      importance: 0.7,
      source: "runtime_reflection",
      tags: input.tags,
      metadata: input.metadata,
    });
  }

  async syncRuntimeMemory(input: ProjectionSyncInput): Promise<ProjectionSyncResult> {
    if (!this.bridge) {
      return {
        success: false,
        direction: input.direction,
        errors: ["No bridge adapter configured for runtime sync"],
      };
    }
    return this.bridge.sync(input);
  }
}

export function createRuntimeMemoryService(
  options: RuntimeMemoryServiceOptions,
): RuntimeMemoryService {
  return new MarvMemRuntimeService(options);
}
