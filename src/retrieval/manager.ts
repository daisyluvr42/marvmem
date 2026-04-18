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

const DEFAULT_MAX_RESULTS = 8;

export class RetrievalManager {
  readonly backend: "builtin" | "qmd";
  readonly usesRemoteEmbeddings: boolean;
  private embeddingProviderPromise: Promise<MemoryEmbeddingProvider | null> | null;
  private readonly qmdBackend: QmdRetrievalBackend | null;

  constructor(private readonly options: RetrievalManagerOptions) {
    this.backend = options.backend ?? "builtin";
    this.usesRemoteEmbeddings = Boolean(options.embeddings);
    this.embeddingProviderPromise = options.embeddingProvider
      ? Promise.resolve(options.embeddingProvider)
      : createEmbeddingProvider(options.embeddings);
    this.qmdBackend = options.qmd?.enabled ? new QmdRetrievalBackend(options.qmd) : null;
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
