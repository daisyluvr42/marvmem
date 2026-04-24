import type { MemoryRecord, MemoryScope, MemorySearchHit } from "../core/types.js";
import type { MemoryEmbeddingProviderConfig, MemoryQmdConfig, MemoryRetrievalBackend } from "../system/types.js";
import type { VectorStore } from "./vector-store.js";

export type RetrievalHit = {
  source: "builtin" | "qmd";
  score: number;
  snippet: string;
  record?: MemoryRecord;
  searchHit?: MemorySearchHit;
  path?: string;
  metadata?: Record<string, unknown>;
};

export type RetrievalRecallResult = {
  query: string;
  hits: RetrievalHit[];
  injectedContext: string;
};

export type EmbeddingVector = number[];

export interface MemoryEmbeddingProvider {
  readonly id: string;
  embedQuery(text: string): Promise<EmbeddingVector>;
  embedDocuments(texts: string[]): Promise<EmbeddingVector[]>;
}

export type RetrievalManagerOptions = {
  memory: {
    search(query: string, options?: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number }): Promise<MemorySearchHit[]>;
    list(options?: { scopes?: MemoryScope[]; limit?: number }): Promise<MemoryRecord[]>;
  };
  backend?: MemoryRetrievalBackend;
  embeddings?: MemoryEmbeddingProviderConfig;
  qmd?: MemoryQmdConfig;
  embeddingProvider?: MemoryEmbeddingProvider;
  vectorStore?: VectorStore;
};
