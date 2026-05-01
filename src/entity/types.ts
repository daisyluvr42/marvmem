// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

export type Entity = {
  id: string;
  name: string;
  aliases: string[];
  kind: EntityKind;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type EntityKind = "person" | "project" | "tech" | "tool" | "org" | (string & {});

export type EntityLink = {
  entityId: string;
  memoryId: string;
  relation: string;
  confidence: number;
  createdAt: string;
};

export type EntityRelation = {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relation: string;
  memoryId?: string;
  confidence: number;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Entity store interface
// ---------------------------------------------------------------------------

export interface EntityStore {
  upsertEntity(input: {
    name: string;
    aliases?: string[];
    kind: EntityKind;
    metadata?: Record<string, unknown>;
  }): Promise<Entity>;

  findByName(name: string): Promise<Entity | null>;
  findByAlias(alias: string): Promise<Entity | null>;
  getEntity(id: string): Promise<Entity | null>;

  link(entityId: string, memoryId: string, relation: string, confidence?: number): Promise<void>;
  unlink(entityId: string, memoryId: string): Promise<void>;
  relate(input: {
    sourceEntityId: string;
    targetEntityId: string;
    relation: string;
    memoryId?: string;
    confidence?: number;
  }): Promise<EntityRelation>;
  clearRelationsForMemory(memoryId: string): Promise<void>;

  getLinkedMemories(entityId: string): Promise<EntityLink[]>;
  getLinkedEntities(memoryId: string): Promise<EntityLink[]>;
  getRelationsForEntity(entityId: string, options?: { limit?: number }): Promise<EntityRelation[]>;
  getRelationsForMemory(memoryId: string): Promise<EntityRelation[]>;

  searchEntities(query: string, options?: { limit?: number }): Promise<Entity[]>;
  listEntities(options?: { limit?: number }): Promise<Entity[]>;
}

// ---------------------------------------------------------------------------
// Entity extractor interface
// ---------------------------------------------------------------------------

export type ExtractedEntity = {
  name: string;
  kind: EntityKind;
  aliases?: string[];
};

export interface EntityExtractor {
  extract(text: string): Promise<ExtractedEntity[]>;
}
