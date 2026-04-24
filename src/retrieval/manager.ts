import { cosineSimilarity } from "../core/hash-embedding.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import { createEmbeddingProvider, HashEmbeddingProvider } from "./embeddings.js";
import { QmdRetrievalBackend } from "./qmd.js";
import type {
  MemoryEmbeddingProvider,
  RetrievalHit,
  RetrievalManagerOptions,
  RetrievalRecallResult,
} from "./types.js";
import type { VectorStore } from "./vector-store.js";
import { buildEmbeddingText } from "./vector-store.js";

const DEFAULT_MAX_RESULTS = 8;

export class RetrievalManager {
  readonly backend: "builtin" | "qmd";
  readonly usesRemoteEmbeddings: boolean;
  private embeddingProviderPromise: Promise<MemoryEmbeddingProvider | null> | null;
  private readonly qmdBackend: QmdRetrievalBackend | null;
  private readonly vectorStore: VectorStore | null;

  constructor(private readonly options: RetrievalManagerOptions) {
    this.backend = options.backend ?? "builtin";
    this.usesRemoteEmbeddings = Boolean(options.embeddings || options.embeddingProvider);
    this.embeddingProviderPromise = options.embeddingProvider
      ? Promise.resolve(options.embeddingProvider)
      : createEmbeddingProvider(options.embeddings);
    this.qmdBackend = options.qmd?.enabled ? new QmdRetrievalBackend(options.qmd) : null;
    this.vectorStore = options.vectorStore ?? null;
  }

  /**
   * Index a memory record into the vector store.
   * Called by the platform service after a successful write.
   * No-op if no vectorStore is configured or no embedding provider.
   */
  async indexRecord(record: MemoryRecord): Promise<void> {
    if (!this.vectorStore) return;
    const provider = (await this.embeddingProviderPromise) ?? new HashEmbeddingProvider();
    const text = buildEmbeddingText(record);
    const vector = await provider.embedQuery(text);
    await this.vectorStore.upsert([{
      id: record.id,
      vector,
      content: text,
      metadata: {
        scopeType: record.scope.type,
        scopeId: record.scope.id,
        kind: record.kind,
      },
    }]);
  }

  /**
   * Remove a record from the vector store.
   * Called by the platform service after a successful delete.
   */
  async deleteVector(id: string): Promise<void> {
    if (!this.vectorStore) return;
    await this.vectorStore.delete([id]);
  }

  async search(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number } = {},
  ): Promise<RetrievalHit[]> {
    const limit = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
    if (this.backend === "qmd" && this.qmdBackend) {
      const qmdHits = await this.qmdBackend.search(query, options);
      if (!this.options.qmd?.includeDefaultMemory) {
        return qmdHits.slice(0, limit);
      }
      const builtinHits = await this.searchBuiltin(query, options);
      return [...qmdHits, ...builtinHits].toSorted((left, right) => right.score - left.score).slice(0, limit);
    }
    return await this.searchBuiltin(query, options);
  }

  async recall(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number; maxChars?: number } = {},
  ): Promise<RetrievalRecallResult> {
    const hits = await this.search(query, options);
    return {
      query: query.trim(),
      hits,
      injectedContext: formatRetrievalContext(hits, options.maxChars ?? 4_000),
    };
  }

  private async searchBuiltin(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number },
  ): Promise<RetrievalHit[]> {
    // Fast path: use vector store for ANN search if available
    if (this.vectorStore) {
      return this.searchVectorStore(query, options);
    }

    const baseHits = await this.options.memory.search(query, {
      scopes: options.scopes,
      maxResults: 512,
      minScore: 0,
    });
    if (baseHits.length === 0) {
      return [];
    }
    const provider = (await this.embeddingProviderPromise) ?? new HashEmbeddingProvider();
    if (provider.id === "hash") {
      return baseHits
        .filter((hit) => hit.score >= (options.minScore ?? 0.18))
        .slice(0, options.maxResults ?? DEFAULT_MAX_RESULTS)
        .map((hit) => ({
          source: "builtin" as const,
          score: hit.score,
          snippet: hit.snippet,
          record: hit.record,
          searchHit: hit,
        }));
    }

    const queryEmbedding = await provider.embedQuery(query);
    const documents = baseHits.map((hit) => buildSearchText(hit.record));
    const vectors = await provider.embedDocuments(documents);
    const combined = baseHits.map((hit, index) => {
      const vector = vectors[index] ?? [];
      const vectorScore = clamp(cosineSimilarity(queryEmbedding, vector), 0, 1);
      return {
        source: "builtin" as const,
        score: hit.score * 0.65 + vectorScore * 0.35,
        snippet: hit.snippet,
        record: hit.record,
        searchHit: {
          ...hit,
          reasons: {
            ...hit.reasons,
            vector: vectorScore,
          },
        } as typeof hit,
      };
    });
    return combined
      .filter((hit) => hit.score >= (options.minScore ?? 0.18))
      .toSorted((left, right) => right.score - left.score)
      .slice(0, options.maxResults ?? DEFAULT_MAX_RESULTS);
  }

  /**
   * ANN search path: query the vector store directly.
   * Falls back to FTS if embedding provider is unavailable.
   */
  private async searchVectorStore(
    query: string,
    options: { scopes?: MemoryScope[]; maxResults?: number; minScore?: number },
  ): Promise<RetrievalHit[]> {
    const provider = (await this.embeddingProviderPromise) ?? new HashEmbeddingProvider();
    const queryVector = await provider.embedQuery(query);
    const limit = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const topK = Math.max(1, limit * 2);
    const filters = buildScopeFilters(options.scopes);
    const batches = filters.length === 0
      ? [await this.vectorStore!.search(queryVector, {
          topK,
          minScore: options.minScore ?? 0.18,
        })]
      : await Promise.all(
          filters.map((filter) =>
            this.vectorStore!.search(queryVector, {
              topK,
              minScore: options.minScore ?? 0.18,
              filter,
            }),
          ),
        );

    const mergedHits = new Map<string, (typeof batches)[number][number]>();
    for (const batch of batches) {
      for (const hit of batch) {
        const existing = mergedHits.get(hit.id);
        if (!existing || hit.score > existing.score) {
          mergedHits.set(hit.id, hit);
        }
      }
    }

    const records = await this.options.memory.list({ scopes: options.scopes });
    const recordsById = new Map(records.map((record) => [record.id, record]));

    const results: RetrievalHit[] = [];
    for (const hit of [...mergedHits.values()].toSorted((left, right) => right.score - left.score)) {
      const record = recordsById.get(hit.id);
      if (!record) {
        continue;
      }
      results.push({
        source: "builtin",
        score: hit.score,
        snippet: record.content.slice(0, 200),
        record,
        metadata: { vectorScore: hit.score },
      });
      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }
}

export function formatRetrievalContext(hits: RetrievalHit[], maxChars: number): string {
  if (hits.length === 0) {
    return "";
  }
  const blocks: string[] = [];
  for (const hit of hits) {
    if (hit.source === "builtin" && hit.record) {
      blocks.push(
        `- [${hit.record.kind}] ${hit.record.summary?.trim() || hit.record.content.trim()} (score ${hit.score.toFixed(2)})`,
      );
      continue;
    }
    const path = hit.path ? ` (${hit.path})` : "";
    blocks.push(`- [qmd] ${hit.snippet.trim()}${path}`);
  }
  const text = `Relevant memory:\n${blocks.join("\n")}`;
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars).trimEnd();
}

function buildSearchText(record: MemoryRecord): string {
  return [record.kind, record.summary ?? "", record.content, record.tags.join(" ")].filter(Boolean).join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildScopeFilters(scopes?: MemoryScope[]): Record<string, unknown>[] {
  if (!scopes || scopes.length === 0) {
    return [];
  }
  const unique = new Map<string, Record<string, unknown>>();
  for (const scope of scopes) {
    unique.set(`${scope.type}:${scope.id}`, {
      scopeType: scope.type,
      scopeId: scope.id,
    });
  }
  return [...unique.values()];
}
