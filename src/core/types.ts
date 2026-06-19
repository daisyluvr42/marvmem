export const MEMORY_SCOPE_TYPES = ["agent", "session", "user", "task", "document", "project", "repo"] as const;

export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export type MemoryScope = {
  type: MemoryScopeType;
  id: string;
  weight?: number;
};

export type MemoryKind =
  | "fact"
  | "preference"
  | "decision"
  | "identity"
  | "experience"
  | "lesson"
  | "note"
  | (string & {});

export type MemoryRecord = {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  summary?: string;
  confidence: number;
  importance: number;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryInput = {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  summary?: string;
  confidence?: number;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type MemorySearchOptions = {
  scopes?: MemoryScope[];
  maxResults?: number;
  minScore?: number;
};

export type MemorySearchHit = {
  record: MemoryRecord;
  score: number;
  reasons: {
    lexical: number;
    hash: number;
    recency: number;
    importance: number;
    scope: number;
    entity?: number;
  };
  snippet: string;
  evidence: MemoryEvidenceRef;
};

export type MemoryRecallOptions = MemorySearchOptions & {
  query: string;
  recentMessages?: string[];
  maxChars?: number;
};

export type MemoryEvidenceRef = {
  recordId: string;
  scope: MemoryScope;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  tools: Array<{
    name: "memory_record" | "memory_task";
    arguments: Record<string, string>;
  }>;
};

export type MemoryRecallResult = {
  query: string;
  hits: MemorySearchHit[];
  injectedContext: string;
  stableContext?: string;
  dynamicContext?: string;
  navigationContext?: string;
  evidence?: MemoryEvidenceRef[];
  layers?: {
    active?: string;
    task?: string;
    palace?: string;
    retrieval?: string;
    graph?: string;
    navigation?: string;
  };
};

export type MemoryListOptions = {
  scopes?: MemoryScope[];
  limit?: number;
};

export interface MemoryStore {
  load(): Promise<MemoryRecord[]>;
  save(records: MemoryRecord[]): Promise<void>;
  upsert?(record: MemoryRecord): Promise<void>;
  delete?(id: string): Promise<void>;
}

export function normalizeScope(scope: MemoryScope): MemoryScope {
  return {
    type: scope.type,
    id: scope.id.trim(),
    weight: scope.weight,
  };
}

export function parseMemoryScopeType(value: string, label = "scopeType"): MemoryScopeType {
  if ((MEMORY_SCOPE_TYPES as readonly string[]).includes(value)) {
    return value as MemoryScopeType;
  }
  throw new Error(
    `Unsupported ${label}: ${value}. Use one of: ${MEMORY_SCOPE_TYPES.join(", ")}. ` +
      `For a new or custom agent, use scopeType "agent" and put the agent name in scopeId.`,
  );
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.type}:${scope.id}`.toLowerCase();
}
