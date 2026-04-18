import { randomUUID } from "node:crypto";
import { cosineSimilarity, embedTextHash } from "./hash-embedding.js";
import { FileMemoryStore } from "./storage.js";
import {
  normalizeScope,
  scopeKey,
  type MemoryInput,
  type MemoryListOptions,
  type MemoryRecallOptions,
  type MemoryRecallResult,
  type MemoryRecord,
  type MemorySearchHit,
  type MemorySearchOptions,
  type MemoryScope,
  type MemoryStore,
} from "./types.js";
import { normalizeText, tokenOverlapScore, uniqueTokens } from "./tokenize.js";

export type SearchWeights = {
  lexical: number;
  hash: number;
  recency: number;
  importance: number;
  scope: number;
};

const DEFAULT_SEARCH_WEIGHTS: SearchWeights = {
  lexical: 0.45,
  hash: 0.35,
  recency: 0.08,
  importance: 0.07,
  scope: 0.05,
};

export type MarvMemOptions = {
  storagePath?: string;
  store?: MemoryStore;
  idFactory?: () => string;
  now?: () => Date;
  embeddingDimensions?: number;
  /** Similarity threshold (0-1) above which a new remember() merges into an existing record instead of creating a new one. Set to 1 to disable. Default 0.85. */
  dedupeThreshold?: number;
  /** Override the default search scoring weights. */
  searchWeights?: Partial<SearchWeights>;
};

export class MarvMem {
  private readonly store: MemoryStore;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly embeddingDimensions: number;
  private readonly dedupeThreshold: number;
  private readonly weights: SearchWeights;

  /** Serialize mutating operations to prevent read-modify-write races. */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: MarvMemOptions = {}) {
    this.store =
      options.store ?? new FileMemoryStore(options.storagePath ?? ".marvmem/memory.json");
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
    this.embeddingDimensions = options.embeddingDimensions ?? 128;
    this.dedupeThreshold = clamp(options.dedupeThreshold ?? 0.85, 0, 1);
    this.weights = { ...DEFAULT_SEARCH_WEIGHTS, ...options.searchWeights };
  }

  async remember(input: MemoryInput): Promise<MemoryRecord> {
    return this.enqueue(async () => {
      const nowIso = this.now().toISOString();
      const records = await this.store.load();

      // --- Deduplicate: merge into existing record if content is near-identical ---
      if (this.dedupeThreshold < 1) {
        const inputText = buildSearchText({
          kind: input.kind,
          content: input.content,
          summary: input.summary,
          tags: input.tags ?? [],
          scope: normalizeScope(input.scope),
        } as MemoryRecord);
        const inputVector = embedTextHash(inputText, this.embeddingDimensions);
        const inputTokens = uniqueTokens(inputText);
        const scopeK = scopeKey(normalizeScope(input.scope));

        for (const existing of records) {
          if (scopeKey(existing.scope) !== scopeK) continue;
          if (existing.kind !== input.kind) continue;
          const existingText = buildSearchText(existing);
          const tokenScore = tokenOverlapScore(inputTokens, uniqueTokens(existingText));
          const hashScore = normalizeSimilarity(
            cosineSimilarity(inputVector, embedTextHash(existingText, this.embeddingDimensions)),
          );
          const similarity = tokenScore * 0.5 + hashScore * 0.5;
          if (similarity >= this.dedupeThreshold) {
            // Merge: update the existing record
            existing.content = input.content.trim();
            existing.summary = input.summary?.trim() || summarizeContent(input.content);
            existing.confidence = clamp(
              Math.max(existing.confidence, input.confidence ?? 0.7),
              0.05,
              1,
            );
            existing.importance = clamp(
              Math.max(existing.importance, input.importance ?? 0.5),
              0,
              1,
            );
            existing.tags = [
              ...new Set([
                ...existing.tags,
                ...(input.tags ?? []).map((tag) => normalizeText(tag)).filter(Boolean),
              ]),
            ];
            existing.updatedAt = nowIso;
            await this.store.save(records);
            return { ...existing, scope: { ...existing.scope }, tags: [...existing.tags] };
          }
        }
      }

      // --- No duplicate found: create new record ---
      const record: MemoryRecord = {
        id: this.idFactory(),
        scope: normalizeScope(input.scope),
        kind: input.kind,
        content: input.content.trim(),
        summary: input.summary?.trim() || summarizeContent(input.content),
        confidence: clamp(input.confidence ?? 0.7, 0.05, 1),
        importance: clamp(input.importance ?? 0.5, 0, 1),
        source: input.source?.trim() || "manual",
        tags: [...new Set((input.tags ?? []).map((tag) => normalizeText(tag)).filter(Boolean))],
        metadata: input.metadata ? { ...input.metadata } : undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      records.push(record);
      await this.store.save(records);
      return record;
    });
  }

  async update(id: string, patch: Partial<MemoryInput>): Promise<MemoryRecord | null> {
    return this.enqueue(async () => {
      const records = await this.store.load();
      const record = records.find((r) => r.id === id);
      if (!record) return null;

      const nowIso = this.now().toISOString();
      if (patch.content !== undefined) record.content = patch.content.trim();
      if (patch.summary !== undefined) record.summary = patch.summary?.trim() || summarizeContent(record.content);
      if (patch.confidence !== undefined) record.confidence = clamp(patch.confidence, 0.05, 1);
      if (patch.importance !== undefined) record.importance = clamp(patch.importance, 0, 1);
      if (patch.source !== undefined) record.source = patch.source?.trim() || record.source;
      if (patch.tags !== undefined) {
        record.tags = [...new Set(patch.tags.map((t) => normalizeText(t)).filter(Boolean))];
      }
      if (patch.kind !== undefined) record.kind = patch.kind;
      if (patch.scope !== undefined) record.scope = normalizeScope(patch.scope);
      if (patch.metadata !== undefined) record.metadata = patch.metadata ? { ...patch.metadata } : undefined;
      record.updatedAt = nowIso;

      await this.store.save(records);
      return { ...record, scope: { ...record.scope }, tags: [...record.tags] };
    });
  }

  async forget(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const records = await this.store.load();
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      await this.store.save(records);
      return true;
    });
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const records = await this.store.load();
    return records.find((record) => record.id === id) ?? null;
  }

  async list(options: MemoryListOptions = {}): Promise<MemoryRecord[]> {
    const records = await this.store.load();
    const filtered = records
      .filter((record) => matchesRequestedScopes(record.scope, options.scopes))
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    if (options.limit && options.limit > 0) {
      return filtered.slice(0, options.limit);
    }
    return filtered;
  }

  async search(query: string, options: MemorySearchOptions = {}): Promise<MemorySearchHit[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const queryTokens = uniqueTokens(normalizedQuery);
    const queryVector = embedTextHash(normalizedQuery, this.embeddingDimensions);
    const records = await this.store.load();
    const scopedRecords = records.filter((record) => matchesRequestedScopes(record.scope, options.scopes));
    const hits: MemorySearchHit[] = [];
    const w = this.weights;

    for (const record of scopedRecords) {
      const candidateText = buildSearchText(record);
      const candidateTokens = uniqueTokens(candidateText);
      const lexical = tokenOverlapScore(queryTokens, candidateTokens);
      const hash = clamp(
        cosineSimilarity(queryVector, embedTextHash(candidateText, this.embeddingDimensions)),
        0,
        1,
      );
      const recency = computeRecencyBoost(record.updatedAt, this.now());
      const importance = record.importance;
      const scope = resolveScopeWeight(record.scope, options.scopes);
      const score = lexical * w.lexical + hash * w.hash + recency * w.recency + importance * w.importance + scope * w.scope;
      if (score < (options.minScore ?? 0.18)) {
        continue;
      }
      hits.push({
        record,
        score,
        reasons: { lexical, hash, recency, importance, scope },
        snippet: buildSnippet(record.content, queryTokens),
      });
    }

    return hits
      .toSorted((left, right) => right.score - left.score)
      .slice(0, options.maxResults ?? 8);
  }

  async recall(options: MemoryRecallOptions): Promise<MemoryRecallResult> {
    const query = buildRecallQuery(options.query, options.recentMessages);
    const hits = await this.search(query, options);
    const injectedContext = formatRecallContext(hits, options.maxChars ?? 4_000);
    return {
      query,
      hits,
      injectedContext,
    };
  }

  /** Enqueue a mutating operation so read-modify-write sequences don't interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(() => {}, () => {});
    return next;
  }
}

export function createMarvMem(options: MarvMemOptions = {}): MarvMem {
  return new MarvMem(options);
}

function matchesRequestedScopes(recordScope: MemoryScope, requestedScopes?: MemoryScope[]): boolean {
  if (!requestedScopes || requestedScopes.length === 0) {
    return true;
  }
  const key = scopeKey(recordScope);
  return requestedScopes.some((scope) => scopeKey(scope) === key);
}

function resolveScopeWeight(recordScope: MemoryScope, requestedScopes?: MemoryScope[]): number {
  if (!requestedScopes || requestedScopes.length === 0) {
    return 0.5;
  }
  const key = scopeKey(recordScope);
  const match = requestedScopes.find((scope) => scopeKey(scope) === key);
  if (!match) {
    return 0;
  }
  return clamp(match.weight ?? 1, 0, 1.5) / 1.5;
}

function buildSearchText(record: MemoryRecord): string {
  return [
    record.kind,
    record.summary ?? "",
    record.content,
    record.tags.join(" "),
    record.scope.type,
    record.scope.id,
  ]
    .filter(Boolean)
    .join("\n");
}

function computeRecencyBoost(iso: string, now: Date): number {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return 0;
  }
  const ageMs = Math.max(0, now.getTime() - timestamp);
  const ageDays = ageMs / 86_400_000;
  return 1 / (1 + ageDays / 30);
}

function buildSnippet(content: string, queryTokens: string[]): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 220) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  const token = queryTokens.find((entry) => lower.includes(entry));
  if (!token) {
    return `${normalized.slice(0, 217)}...`;
  }
  const index = lower.indexOf(token);
  const start = Math.max(0, index - 90);
  const end = Math.min(normalized.length, index + 130);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function summarizeContent(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

function normalizeSimilarity(value: number): number {
  return clamp((value + 1) / 2, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildRecallQuery(query: string, recentMessages?: string[]): string {
  const parts = [
    query.trim(),
    ...(recentMessages ?? []).map((message) => message.trim()).filter(Boolean),
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 1200);
}

export function formatRecallContext(hits: MemorySearchHit[], maxChars: number): string {
  if (hits.length === 0) {
    return "";
  }
  const lines = [
    "Relevant long-term memory:",
    "Use these memories as supporting context.",
    "",
  ];
  let used = lines.join("\n").length;
  for (const hit of hits) {
    const block = [
      `- [${hit.record.kind}] ${hit.record.scope.type}:${hit.record.scope.id} (score ${hit.score.toFixed(2)})`,
      `  ${hit.record.content.trim()}`,
    ].join("\n");
    if (used + block.length + 1 > maxChars) {
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }
  return lines.join("\n").trim();
}
