export type MemoryScopeType = "agent" | "session" | "user" | "task" | "document";

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
  };
  snippet: string;
};

export type MemoryRecallOptions = MemorySearchOptions & {
  query: string;
  recentMessages?: string[];
  maxChars?: number;
};

export type MemoryRecallResult = {
  query: string;
  hits: MemorySearchHit[];
  injectedContext: string;
};

export type MemoryListOptions = {
  scopes?: MemoryScope[];
  limit?: number;
};

export interface MemoryStore {
  load(): Promise<MemoryRecord[]>;
  save(records: MemoryRecord[]): Promise<void>;
}

export function normalizeScope(scope: MemoryScope): MemoryScope {
  return {
    type: scope.type,
    id: scope.id.trim(),
    weight: scope.weight,
  };
}

export function scopeKey(scope: MemoryScope): string {
  return `${scope.type}:${scope.id}`.toLowerCase();
}

