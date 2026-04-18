import type { MemoryScope } from "../core/types.js";
import type { MemoryInferencer } from "../system/types.js";

export type ActiveMemoryKind = "context" | "experience";

export type ActiveMemoryDocument = {
  kind: ActiveMemoryKind;
  scope: MemoryScope;
  content: string;
  metadata?: Record<string, unknown>;
  updatedAt: string;
};

export type ActiveMemoryStore = {
  get(kind: ActiveMemoryKind, scope: MemoryScope): Promise<ActiveMemoryDocument | null>;
  put(
    document: Omit<ActiveMemoryDocument, "updatedAt"> & { updatedAt?: string },
  ): Promise<ActiveMemoryDocument>;
  delete(kind: ActiveMemoryKind, scope: MemoryScope): Promise<boolean>;
};

export type ActiveMemoryManagerOptions = {
  store: ActiveMemoryStore;
  inferencer?: MemoryInferencer;
  now?: () => Date;
  contextMaxChars?: number;
  experienceMaxChars?: number;
};
