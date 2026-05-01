import { cosineSimilarity } from "../core/hash-embedding.js";
import type {
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "./vector-store.js";

// ---------------------------------------------------------------------------
// In-memory vector store (brute-force cosine scan)
// ---------------------------------------------------------------------------

/**
 * Zero-dependency vector store for testing and small-scale local use.
 * Performs brute-force cosine similarity — equivalent to the existing
 * hash-embedding search path but behind a pluggable interface.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly id = "memory";
  private readonly docs = new Map<string, VectorDocument>();

  async upsert(docs: VectorDocument[]): Promise<void> {
    for (const doc of docs) {
      this.docs.set(doc.id, { ...doc, vector: [...doc.vector] });
    }
  }

  async search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const topK = options?.topK ?? 10;
    const minScore = options?.minScore ?? 0;
    const results: VectorSearchResult[] = [];

    for (const doc of this.docs.values()) {
      if (!matchesFilter(doc, options?.filter)) {
        continue;
      }
      const score = clamp(cosineSimilarity(queryVector, doc.vector), 0, 1);
      if (score >= minScore) {
        results.push({
          id: doc.id,
          score,
          content: doc.content,
          metadata: doc.metadata,
        });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.docs.delete(id);
    }
  }

  async count(): Promise<number> {
    return this.docs.size;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function matchesFilter(
  doc: VectorDocument,
  filter?: Record<string, unknown>,
): boolean {
  if (!filter || Object.keys(filter).length === 0) {
    return true;
  }
  const metadata = doc.metadata ?? {};
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}
