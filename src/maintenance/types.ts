import type { ActiveMemoryManager } from "../active/manager.js";
import type { MemoryScope } from "../core/types.js";
import type { MemoryInferencer } from "../system/types.js";

export type ExperienceEntryStat = {
  id: string;
  text: string;
  activationCount: number;
  positiveCount: number;
  firstSeenAt: string;
  lastActivatedAt?: string;
};

export type ExperienceAttributionResult = {
  activatedEntries: Array<{
    entryId: string;
    confidence: number;
  }>;
  outcome: "positive" | "neutral" | "negative";
};

export type ExperienceCalibrationResult = {
  driftDetected: boolean;
  driftReport?: string;
  zombieRemoved: string[];
  harmfulFlagged: string[];
  coreConfirmed: string[];
};

export type ExperienceRebuildResult = {
  content: string;
  sourceFragments: string[];
};

export type MaintenanceManagerOptions = {
  active: ActiveMemoryManager;
  inferencer?: MemoryInferencer;
  now?: () => Date;
  memory: {
    list(options?: { scopes?: MemoryScope[]; limit?: number }): Promise<
      Array<{
        content: string;
        summary?: string;
        kind: string;
        updatedAt: string;
      }>
    >;
  };
};
