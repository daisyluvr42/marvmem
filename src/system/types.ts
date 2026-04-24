import type { MemoryScope } from "../core/types.js";

export type MemoryStorageBackend = "sqlite" | "memory";
export type MemoryRetrievalBackend = "builtin" | "qmd";

export type MemoryInferencerKind =
  | "context"
  | "experience"
  | "task_summary"
  | "attribution"
  | "calibration"
  | "evaluation"
  | "entity_extraction"
  | "memory_extraction";

export type MemoryInferencerInput = {
  kind: MemoryInferencerKind;
  system: string;
  prompt: string;
  maxChars?: number;
  currentContent?: string;
};

export type MemoryInferencerResult =
  | { ok: true; text: string }
  | { ok: false; error?: string };

export type MemoryInferencer = (
  input: MemoryInferencerInput,
) => Promise<MemoryInferencerResult>;

export type MemoryEmbeddingProviderId = "openai" | "gemini" | "voyage" | "script";

export type MemoryEmbeddingProviderConfig = {
  provider: MemoryEmbeddingProviderId | "auto";
  model?: string;
  dimensions?: number;
  fallback?: MemoryEmbeddingProviderId | "none";
  remote?: {
    apiKey?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
  };
};

export type MemoryQmdConfig = {
  enabled?: boolean;
  command?: string;
  collections?: Array<{
    name: string;
    path: string;
    pattern?: string;
    kind?: "memory" | "sessions";
  }>;
  includeDefaultMemory?: boolean;
  maxResults?: number;
  maxSnippetChars?: number;
  maxInjectedChars?: number;
  timeoutMs?: number;
};

export type MemorySubsystemOptions = {
  storage?: {
    backend?: MemoryStorageBackend;
    path?: string;
  };
  inferencer?: MemoryInferencer;
  retrieval?: {
    backend?: MemoryRetrievalBackend;
    embeddings?: MemoryEmbeddingProviderConfig;
    qmd?: MemoryQmdConfig;
  };
  active?: {
    contextMaxChars?: number;
    experienceMaxChars?: number;
  };
};

export type ScopedDocumentInput = {
  scope: MemoryScope;
  content: string;
  metadata?: Record<string, unknown>;
};
