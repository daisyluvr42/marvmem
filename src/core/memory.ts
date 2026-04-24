import { randomUUID } from "node:crypto";
import { ActiveMemoryManager } from "../active/manager.js";
import { InMemoryActiveMemoryStore, SqliteActiveMemoryStore } from "../active/store.js";
import type { EntityExtractor, EntityStore } from "../entity/types.js";
import { MaintenanceManager } from "../maintenance/manager.js";
import { RetrievalManager } from "../retrieval/manager.js";
import type { VectorStore } from "../retrieval/vector-store.js";
import { TaskContextManager } from "../task/manager.js";
import { InMemoryTaskContextStore, SqliteTaskContextStore } from "../task/store.js";
import type { MemoryInferencer, MemoryStorageBackend } from "../system/types.js";
import { cosineSimilarity, embedTextHash } from "./hash-embedding.js";
import type { MemoryEvaluator } from "./evaluator.js";
import { InMemoryStore, SqliteMemoryStore } from "./storage.js";
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

const ENTITY_MATCH_BOOST = 0.18;

export type MarvMemOptions = {
  storage?: {
    backend?: MemoryStorageBackend;
    path?: string;
  };
  storagePath?: string;
  store?: MemoryStore;
  idFactory?: () => string;
  now?: () => Date;
  inferencer?: MemoryInferencer;
  retrieval?: {
    backend?: "builtin" | "qmd";
    vectorStore?: VectorStore;
    embeddings?: {
      provider: "openai" | "gemini" | "voyage" | "script" | "auto";
      model?: string;
      dimensions?: number;
      fallback?: "openai" | "gemini" | "voyage" | "script" | "none";
      remote?: {
        apiKey?: string;
        baseUrl?: string;
        headers?: Record<string, string>;
      };
    };
    qmd?: {
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
  };
  active?: {
    contextMaxChars?: number;
    experienceMaxChars?: number;
  };
  task?: {
    recentEntriesLimit?: number;
    windowMaxChars?: number;
    summaryMaxChars?: number;
  };
  embeddingDimensions?: number;
  /** Similarity threshold (0-1) above which a new remember() merges into an existing record instead of creating a new one. Set to 1 to disable. Default 0.85. */
  dedupeThreshold?: number;
  /** Pluggable memory evaluator for conflict resolution. When set, used instead of dedupeThreshold. */
  evaluator?: MemoryEvaluator;
  /** Optional entity store for lightweight entity linking. */
  entityStore?: EntityStore;
  /** Optional entity extractor. Requires entityStore to persist links. */
  entityExtractor?: EntityExtractor;
  /** Override the default search scoring weights. */
  searchWeights?: Partial<SearchWeights>;
};

export class MarvMem {
  private readonly store: MemoryStore;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly embeddingDimensions: number;
  private readonly dedupeThreshold: number;
  private readonly evaluator: MemoryEvaluator | null;
  private readonly weights: SearchWeights;
  readonly active: ActiveMemoryManager;
  readonly task: TaskContextManager;
  readonly retrieval: RetrievalManager;
  readonly maintenance: MaintenanceManager;
  readonly entityStore: EntityStore | null;
  readonly entityExtractor: EntityExtractor | null;

  /** Serialize mutating operations to prevent read-modify-write races. */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: MarvMemOptions = {}) {
    const storageBackend = resolveStorageBackend(options);
    const storagePath = options.storage?.path ?? options.storagePath ?? ".marvmem/memory.sqlite";
    const sqlitePath = deriveSqlitePath(storagePath);
    this.store = options.store ?? createDefaultStore(storageBackend, storagePath);
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
    this.embeddingDimensions = options.embeddingDimensions ?? 128;
    this.dedupeThreshold = clamp(options.dedupeThreshold ?? 0.85, 0, 1);
    this.evaluator = options.evaluator ?? null;
    this.weights = { ...DEFAULT_SEARCH_WEIGHTS, ...options.searchWeights };
    this.entityStore = options.entityStore ?? null;
    this.entityExtractor = options.entityExtractor ?? null;
    this.active = new ActiveMemoryManager({
      store:
        storageBackend === "memory" || options.store instanceof InMemoryStore
          ? new InMemoryActiveMemoryStore()
          : new SqliteActiveMemoryStore(sqlitePath),
      inferencer: options.inferencer,
      now: this.now,
      contextMaxChars: options.active?.contextMaxChars,
      experienceMaxChars: options.active?.experienceMaxChars,
    });
    this.task = new TaskContextManager({
      store:
        storageBackend === "memory" || options.store instanceof InMemoryStore
          ? new InMemoryTaskContextStore()
          : new SqliteTaskContextStore(sqlitePath),
      inferencer: options.inferencer,
      now: this.now,
      recentEntriesLimit: options.task?.recentEntriesLimit,
      windowMaxChars: options.task?.windowMaxChars,
      summaryMaxChars: options.task?.summaryMaxChars,
    });
    this.retrieval = new RetrievalManager({
      memory: this,
      backend: options.retrieval?.backend,
      vectorStore: options.retrieval?.vectorStore,
      embeddings: options.retrieval?.embeddings,
      qmd: options.retrieval?.qmd,
    });
    this.maintenance = new MaintenanceManager({
      active: this.active,
      inferencer: options.inferencer,
      now: this.now,
      memory: this,
    });
  }

  async remember(input: MemoryInput): Promise<MemoryRecord> {
    return this.enqueue(async () => {
      const nowIso = this.now().toISOString();
      const records = await this.store.load();

      // --- Evaluate: use evaluator or fallback to threshold-based dedup ---
      if (this.evaluator || this.dedupeThreshold < 1) {
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

        // Collect candidates with similarity scores
        const candidates: Array<{ record: MemoryRecord; similarity: number }> = [];
        for (const existing of records) {
          if (scopeKey(existing.scope) !== scopeK) continue;
          if (existing.kind !== input.kind) continue;
          const existingText = buildSearchText(existing);
          const tokenScore = tokenOverlapScore(inputTokens, uniqueTokens(existingText));
          const hashScore = normalizeSimilarity(
            cosineSimilarity(inputVector, embedTextHash(existingText, this.embeddingDimensions)),
          );
          const similarity = tokenScore * 0.5 + hashScore * 0.5;
          const candidateThreshold = this.evaluator ? 0.7 : this.dedupeThreshold * 0.7;
          if (similarity >= candidateThreshold) {
            candidates.push({ record: existing, similarity });
          }
        }

        if (candidates.length > 0) {
          // Sort by similarity descending
          candidates.sort((a, b) => b.similarity - a.similarity);

          if (this.evaluator) {
            // Use evaluator for intelligent conflict resolution
            const decision = await this.evaluator.evaluate({
              incoming: { content: input.content, kind: input.kind, tags: input.tags ?? [] },
              candidates: candidates.map((c) => ({
                id: c.record.id,
                content: c.record.content,
                kind: c.record.kind,
                similarity: c.similarity,
              })),
            });

            if (decision.action === "ignore") {
              // Return existing record unchanged
              const best = candidates[0]!.record;
              return { ...best, scope: { ...best.scope }, tags: [...best.tags] };
            }

            if (decision.action === "update") {
              const target = records.find((r) => r.id === decision.targetId);
              if (target) {
                target.content = (decision.merged || input.content).trim();
                target.summary = summarizeContent(target.content);
                target.confidence = clamp(Math.max(target.confidence, input.confidence ?? 0.7), 0.05, 1);
                target.importance = clamp(Math.max(target.importance, input.importance ?? 0.5), 0, 1);
                target.tags = [...new Set([...target.tags, ...(input.tags ?? []).map((t) => normalizeText(t)).filter(Boolean)])];
                target.updatedAt = nowIso;
                await this.store.save(records);
                await this.syncDerivedState(target);
                return { ...target, scope: { ...target.scope }, tags: [...target.tags] };
              }
            }

            if (decision.action === "contradict") {
              const target = records.find((r) => r.id === decision.targetId);
              if (target) {
                const previousContent = target.content;
                target.content = (decision.resolution || input.content).trim();
                target.summary = summarizeContent(target.content);
                target.confidence = clamp(input.confidence ?? 0.7, 0.05, 1);
                target.importance = clamp(input.importance ?? 0.5, 0, 1);
                target.tags = [...new Set([...target.tags, ...(input.tags ?? []).map((t) => normalizeText(t)).filter(Boolean)])];
                target.updatedAt = nowIso;
                target.metadata = { ...target.metadata, contradicted: true, previousContent };
                await this.store.save(records);
                await this.syncDerivedState(target);
                return { ...target, scope: { ...target.scope }, tags: [...target.tags] };
              }
            }
            // action === "add" falls through to create new record below
          } else {
            // Legacy threshold-based dedup (no evaluator)
            const best = candidates[0]!;
            if (best.similarity >= this.dedupeThreshold) {
              const existing = best.record;
              existing.content = input.content.trim();
              existing.summary = input.summary?.trim() || summarizeContent(input.content);
              existing.confidence = clamp(Math.max(existing.confidence, input.confidence ?? 0.7), 0.05, 1);
              existing.importance = clamp(Math.max(existing.importance, input.importance ?? 0.5), 0, 1);
              existing.tags = [...new Set([...existing.tags, ...(input.tags ?? []).map((tag) => normalizeText(tag)).filter(Boolean)])];
              existing.updatedAt = nowIso;
              await this.store.save(records);
              await this.syncDerivedState(existing);
              return { ...existing, scope: { ...existing.scope }, tags: [...existing.tags] };
            }
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
      await this.syncDerivedState(record);
      return record;
    });
  }

  async update(id: string, patch: Partial<MemoryInput>): Promise<MemoryRecord | null> {
    return this.enqueue(async () => {
      const records = await this.store.load();
      const record = records.find((r) => r.id === id);
      if (!record) return null;

      const nowIso = this.now().toISOString();
      const contentChanged = patch.content !== undefined;
      if (patch.content !== undefined) record.content = patch.content.trim();
      if (patch.summary !== undefined) record.summary = patch.summary?.trim() || summarizeContent(record.content);
      else if (contentChanged) record.summary = summarizeContent(record.content);
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
      await this.syncDerivedState(record);
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
      await this.retrieval.deleteVector(id);
      await this.clearEntityLinks(id);
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
    const entityMatchedIds = await this.resolveEntityMemoryIds(normalizedQuery);
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
      const entity = entityMatchedIds.has(record.id) ? 1 : 0;
      const recency = computeRecencyBoost(record.updatedAt, this.now());
      const importance = record.importance;
      const scope = resolveScopeWeight(record.scope, options.scopes);
      const score =
        lexical * w.lexical +
        hash * w.hash +
        recency * w.recency +
        importance * w.importance +
        scope * w.scope +
        entity * ENTITY_MATCH_BOOST;
      if (score < (options.minScore ?? 0.18)) {
        continue;
      }
      hits.push({
        record,
        score,
        reasons: { lexical, hash, recency, importance, scope, entity },
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
    const graphContext = await this.formatEntityGraphContext(query, hits);
    const injectedContext = [formatRecallContext(hits, options.maxChars ?? 4_000), graphContext]
      .filter(Boolean)
      .join("\n\n");
    return {
      query,
      hits,
      injectedContext,
      layers: graphContext ? { graph: graphContext } : undefined,
    };
  }

  /** Enqueue a mutating operation so read-modify-write sequences don't interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(fn, fn);
    this.mutationQueue = next.then(() => {}, () => {});
    return next;
  }

  private async syncDerivedState(record: MemoryRecord): Promise<void> {
    await this.retrieval.indexRecord(record);
    await this.syncEntitiesForRecord(record);
  }

  private async syncEntitiesForRecord(record: MemoryRecord): Promise<void> {
    if (!this.entityStore || !this.entityExtractor) {
      return;
    }

    await this.clearEntityLinks(record.id);
    const text = [record.summary ?? "", record.content].filter(Boolean).join("\n");
    if (!text.trim()) {
      return;
    }

    const extracted = await this.entityExtractor.extract(text);
    const storedEntities = [];
    for (const entity of extracted) {
      const stored = await this.entityStore.upsertEntity({
        name: entity.name,
        aliases: entity.aliases,
        kind: entity.kind,
      });
      storedEntities.push(stored);
      await this.entityStore.link(stored.id, record.id, "mentions");
    }
    for (let i = 0; i < storedEntities.length; i++) {
      for (let j = i + 1; j < storedEntities.length; j++) {
        await this.entityStore.relate({
          sourceEntityId: storedEntities[i]!.id,
          targetEntityId: storedEntities[j]!.id,
          relation: "co_occurs",
          memoryId: record.id,
          confidence: 0.5,
        });
      }
    }
  }

  private async clearEntityLinks(memoryId: string): Promise<void> {
    if (!this.entityStore) {
      return;
    }
    await this.entityStore.clearRelationsForMemory(memoryId);
    const links = await this.entityStore.getLinkedEntities(memoryId);
    for (const link of links) {
      await this.entityStore.unlink(link.entityId, memoryId);
    }
  }

  private async resolveEntityMemoryIds(query: string): Promise<Set<string>> {
    const entityIds = await this.resolveEntityIds(query);
    const memoryIds = new Set<string>();
    for (const entityId of entityIds) {
      const links = await this.entityStore!.getLinkedMemories(entityId);
      for (const link of links) {
        memoryIds.add(link.memoryId);
      }
    }
    return memoryIds;
  }

  private async resolveEntityIds(query: string): Promise<Set<string>> {
    if (!this.entityStore) {
      return new Set();
    }

    const entityIds = new Set<string>();
    const trimmed = query.trim();
    if (!trimmed) {
      return new Set();
    }

    const directMatches = await Promise.all([
      this.entityStore.findByName(trimmed),
      this.entityStore.findByAlias(trimmed),
      this.entityStore.searchEntities(trimmed, { limit: 8 }),
    ]);
    const extracted = this.entityExtractor ? await this.entityExtractor.extract(trimmed) : [];

    for (const match of directMatches[0] ? [directMatches[0]] : []) {
      entityIds.add(match.id);
    }
    for (const match of directMatches[1] ? [directMatches[1]] : []) {
      entityIds.add(match.id);
    }
    for (const entity of directMatches[2]) {
      entityIds.add(entity.id);
    }

    for (const entity of extracted) {
      const matched = await this.entityStore.findByName(entity.name);
      if (matched) {
        entityIds.add(matched.id);
      }
      for (const alias of entity.aliases ?? []) {
        const aliasMatch = await this.entityStore.findByAlias(alias);
        if (aliasMatch) {
          entityIds.add(aliasMatch.id);
        }
      }
    }

    return entityIds;
  }

  private async formatEntityGraphContext(query: string, hits: MemorySearchHit[]): Promise<string> {
    if (!this.entityStore) {
      return "";
    }

    const entityIds = await this.resolveEntityIds(query);
    for (const hit of hits.slice(0, 5)) {
      const links = await this.entityStore.getLinkedEntities(hit.record.id);
      for (const link of links) {
        entityIds.add(link.entityId);
      }
    }
    if (entityIds.size === 0) {
      return "";
    }

    const names = new Map<string, string>();
    for (const id of entityIds) {
      const entity = await this.entityStore.getEntity(id);
      if (entity) {
        names.set(id, entity.name);
      }
    }

    const lines: string[] = [];
    const seenRelations = new Set<string>();
    for (const id of entityIds) {
      const relations = await this.entityStore.getRelationsForEntity(id, { limit: 4 });
      for (const relation of relations) {
        const source = names.get(relation.sourceEntityId) ?? (await this.entityStore.getEntity(relation.sourceEntityId))?.name;
        const target = names.get(relation.targetEntityId) ?? (await this.entityStore.getEntity(relation.targetEntityId))?.name;
        if (!source || !target) {
          continue;
        }
        const key = `${relation.sourceEntityId}:${relation.targetEntityId}:${relation.relation}:${relation.memoryId ?? ""}`;
        if (seenRelations.has(key)) {
          continue;
        }
        seenRelations.add(key);
        lines.push(`- ${source} ${relation.relation} ${target}`);
        if (lines.length >= 8) {
          break;
        }
      }
      if (lines.length >= 8) {
        break;
      }
    }

    if (lines.length > 0) {
      return `Related entity graph:\n${lines.join("\n")}`;
    }
    const entityList = [...names.values()].slice(0, 8);
    return entityList.length > 0 ? `Related entities:\n${entityList.map((name) => `- ${name}`).join("\n")}` : "";
  }
}

export function createMarvMem(options: MarvMemOptions = {}): MarvMem {
  return new MarvMem(options);
}

function createDefaultStore(backend: MemoryStorageBackend, storagePath: string): MemoryStore {
  if (backend === "memory") {
    return new InMemoryStore();
  }
  return new SqliteMemoryStore(deriveSqlitePath(storagePath));
}

function resolveStorageBackend(options: MarvMemOptions): MemoryStorageBackend {
  if (options.storage?.backend) {
    return options.storage.backend;
  }
  if (options.store instanceof InMemoryStore) {
    return "memory";
  }
  return "sqlite";
}

function deriveSqlitePath(storagePath: string): string {
  if (storagePath.endsWith(".sqlite") || storagePath.endsWith(".db")) {
    return storagePath;
  }
  return storagePath.includes(".") ? storagePath : `${storagePath}.sqlite`;
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
