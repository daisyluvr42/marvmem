import type { MemoryRecord } from "../core/types.js";

// ---------------------------------------------------------------------------
// Vector store types
// ---------------------------------------------------------------------------

export type VectorDocument = {
  id: string;
  vector: number[];
  content: string;
  metadata?: Record<string, unknown>;
};

export type VectorSearchResult = {
  id: string;
  score: number;
  content: string;
  metadata?: Record<string, unknown>;
};

export type VectorSearchOptions = {
  topK?: number;
  filter?: Record<string, unknown>;
  minScore?: number;
};

// ---------------------------------------------------------------------------
// Vector store interface
// ---------------------------------------------------------------------------

/**
 * Pluggable vector store abstraction.
 *
 * MarvMem ships two implementations:
 * - `InMemoryVectorStore` — zero-dependency, brute-force cosine (test / dev)
 * - `QdrantVectorStore` — REST-based ANN via Qdrant (production)
 */
export interface VectorStore {
  readonly id: string;

  /** Insert or update documents. Vectors must be pre-computed. */
  upsert(docs: VectorDocument[]): Promise<void>;

  /** ANN / brute-force vector search. */
  search(queryVector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;

  /** Delete by document IDs. */
  delete(ids: string[]): Promise<void>;

  /** Total document count. */
  count(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a text string suitable for embedding from a MemoryRecord.
 */
export function buildEmbeddingText(record: MemoryRecord): string {
  return [record.kind, record.summary ?? "", record.content, record.tags.join(" ")]
    .filter(Boolean)
    .join("\n");
}
