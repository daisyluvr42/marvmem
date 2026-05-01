import type {
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "./vector-store.js";

// ---------------------------------------------------------------------------
// Qdrant vector store (REST API)
// ---------------------------------------------------------------------------

export type QdrantVectorStoreOptions = {
  /** Qdrant REST URL, default http://localhost:6333 */
  url?: string;
  /** Collection name, default "marvmem" */
  collection?: string;
  /** Vector dimensions — must match embedding provider output */
  dimensions: number;
  /** API key for Qdrant Cloud (optional for local) */
  apiKey?: string;
};

/**
 * Vector store backed by Qdrant REST API.
 * Requires a running Qdrant instance (Docker or cloud).
 *
 * Auto-creates the collection on first upsert if it doesn't exist.
 */
export class QdrantVectorStore implements VectorStore {
  readonly id = "qdrant";
  private readonly url: string;
  private readonly collection: string;
  private readonly dimensions: number;
  private readonly headers: Record<string, string>;
  private collectionReady = false;

  constructor(options: QdrantVectorStoreOptions) {
    this.url = (options.url ?? "http://localhost:6333").replace(/\/+$/, "");
    this.collection = options.collection ?? "marvmem";
    this.dimensions = options.dimensions;
    this.headers = {
      "Content-Type": "application/json",
      ...(options.apiKey ? { "api-key": options.apiKey } : {}),
    };
  }

  async upsert(docs: VectorDocument[]): Promise<void> {
    await this.ensureCollection();
    const points = docs.map((doc) => ({
      id: doc.id,
      vector: doc.vector,
      payload: {
        content: doc.content,
        ...(doc.metadata ?? {}),
      },
    }));

    const response = await fetch(
      `${this.url}/collections/${this.collection}/points?wait=true`,
      {
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify({ points }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Qdrant upsert failed (${response.status}): ${text}`);
    }
  }

  async search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    await this.ensureCollection();
    const topK = options?.topK ?? 10;
    const minScore = options?.minScore ?? 0;

    const body: Record<string, unknown> = {
      vector: queryVector,
      limit: topK,
      score_threshold: minScore,
      with_payload: true,
    };

    if (options?.filter && Object.keys(options.filter).length > 0) {
      body.filter = buildQdrantFilter(options.filter);
    }

    const response = await fetch(
      `${this.url}/collections/${this.collection}/points/search`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Qdrant search failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      result?: Array<{
        id: string;
        score: number;
        payload?: Record<string, unknown>;
      }>;
    };

    return (data.result ?? []).map((hit) => ({
      id: String(hit.id),
      score: hit.score,
      content: String(hit.payload?.content ?? ""),
      metadata: hit.payload,
    }));
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const response = await fetch(
      `${this.url}/collections/${this.collection}/points/delete?wait=true`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ points: ids }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Qdrant delete failed (${response.status}): ${text}`);
    }
  }

  async count(): Promise<number> {
    try {
      const response = await fetch(
        `${this.url}/collections/${this.collection}`,
        { headers: this.headers },
      );
      if (!response.ok) return 0;
      const data = (await response.json()) as {
        result?: { points_count?: number };
      };
      return data.result?.points_count ?? 0;
    } catch {
      return 0;
    }
  }

  private async ensureCollection(): Promise<void> {
    if (this.collectionReady) return;

    const checkRes = await fetch(
      `${this.url}/collections/${this.collection}`,
      { headers: this.headers },
    );

    if (checkRes.ok) {
      this.collectionReady = true;
      return;
    }

    // Create collection
    const createRes = await fetch(
      `${this.url}/collections/${this.collection}`,
      {
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify({
          vectors: {
            size: this.dimensions,
            distance: "Cosine",
          },
        }),
      },
    );
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Qdrant create collection failed (${createRes.status}): ${text}`);
    }

    this.collectionReady = true;
  }
}

function buildQdrantFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const must: Array<Record<string, unknown>> = [];
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === "string") {
      must.push({ key, match: { value } });
    } else if (typeof value === "number" || typeof value === "boolean") {
      must.push({ key, match: { value } });
    }
  }
  return must.length > 0 ? { must } : {};
}
