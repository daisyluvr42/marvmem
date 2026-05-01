import { randomUUID } from "node:crypto";
import { openSqliteDatabase, parseJsonObject, parseJsonStringArray } from "../system/sqlite.js";
import type {
  Entity,
  EntityKind,
  EntityLink,
  EntityRelation,
  EntityStore,
} from "./types.js";

type EntityRow = {
  id: string;
  name: string;
  aliases_json: string;
  kind: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

type LinkRow = {
  entity_id: string;
  memory_id: string;
  relation: string;
  confidence: number;
  created_at: string;
};

type RelationRow = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation: string;
  memory_id: string | null;
  confidence: number;
  created_at: string;
};

export class SqliteEntityStore implements EntityStore {
  constructor(private readonly filePath: string) {}

  async upsertEntity(input: {
    name: string;
    aliases?: string[];
    kind: EntityKind;
    metadata?: Record<string, unknown>;
  }): Promise<Entity> {
    const name = input.name.trim();
    const nameKey = normalizeKey(name);
    const aliases = normalizeAliases(input.aliases);
    using db = openSqliteDatabase(this.filePath);
    const existing = findEntityRow(db, nameKey, aliases);
    const now = new Date().toISOString();

    if (existing) {
      const mergedAliases = [...new Set([...parseJsonStringArray(existing.aliases_json), ...aliases])];
      const metadata = input.metadata
        ? { ...parseJsonObject(existing.metadata_json), ...input.metadata }
        : parseJsonObject(existing.metadata_json);
      db.prepare(
        "UPDATE entities SET aliases_json = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(mergedAliases), metadata ? JSON.stringify(metadata) : null, now, existing.id);
      return rowToEntity({ ...existing, aliases_json: JSON.stringify(mergedAliases), metadata_json: metadata ? JSON.stringify(metadata) : null, updated_at: now });
    }

    const entity: Entity = {
      id: `ent_${randomUUID().slice(0, 8)}`,
      name,
      aliases,
      kind: input.kind,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      "INSERT INTO entities (id, name, name_key, aliases_json, kind, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      entity.id,
      entity.name,
      nameKey,
      JSON.stringify(entity.aliases),
      entity.kind,
      entity.metadata ? JSON.stringify(entity.metadata) : null,
      entity.createdAt,
      entity.updatedAt,
    );
    return entity;
  }

  async findByName(name: string): Promise<Entity | null> {
    using db = openSqliteDatabase(this.filePath);
    const row = db.prepare("SELECT * FROM entities WHERE name_key = ?").get(normalizeKey(name)) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  async findByAlias(alias: string): Promise<Entity | null> {
    const normalized = normalizeKey(alias);
    using db = openSqliteDatabase(this.filePath);
    const rows = db.prepare("SELECT * FROM entities").all() as EntityRow[];
    const row = rows.find((entry) => parseJsonStringArray(entry.aliases_json).includes(normalized));
    return row ? rowToEntity(row) : null;
  }

  async getEntity(id: string): Promise<Entity | null> {
    using db = openSqliteDatabase(this.filePath);
    const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  async link(entityId: string, memoryId: string, relation: string, confidence = 1): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.prepare(
      "INSERT OR IGNORE INTO entity_links (entity_id, memory_id, relation, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(entityId, memoryId, relation, confidence, new Date().toISOString());
  }

  async unlink(entityId: string, memoryId: string): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.prepare("DELETE FROM entity_links WHERE entity_id = ? AND memory_id = ?").run(entityId, memoryId);
  }

  async relate(input: {
    sourceEntityId: string;
    targetEntityId: string;
    relation: string;
    memoryId?: string;
    confidence?: number;
  }): Promise<EntityRelation> {
    using db = openSqliteDatabase(this.filePath);
    const existing = db.prepare(
      "SELECT * FROM entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation = ? AND COALESCE(memory_id, '') = COALESCE(?, '')",
    ).get(input.sourceEntityId, input.targetEntityId, input.relation, input.memoryId ?? null) as RelationRow | undefined;
    if (existing) {
      return rowToRelation(existing);
    }

    const relation: EntityRelation = {
      id: `rel_${randomUUID().slice(0, 8)}`,
      sourceEntityId: input.sourceEntityId,
      targetEntityId: input.targetEntityId,
      relation: input.relation,
      memoryId: input.memoryId,
      confidence: input.confidence ?? 1,
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      "INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation, memory_id, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      relation.id,
      relation.sourceEntityId,
      relation.targetEntityId,
      relation.relation,
      relation.memoryId ?? null,
      relation.confidence,
      relation.createdAt,
    );
    return relation;
  }

  async clearRelationsForMemory(memoryId: string): Promise<void> {
    using db = openSqliteDatabase(this.filePath);
    db.prepare("DELETE FROM entity_relations WHERE memory_id = ?").run(memoryId);
  }

  async getLinkedMemories(entityId: string): Promise<EntityLink[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db.prepare("SELECT * FROM entity_links WHERE entity_id = ?").all(entityId) as LinkRow[];
    return rows.map(rowToLink);
  }

  async getLinkedEntities(memoryId: string): Promise<EntityLink[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db.prepare("SELECT * FROM entity_links WHERE memory_id = ?").all(memoryId) as LinkRow[];
    return rows.map(rowToLink);
  }

  async getRelationsForEntity(entityId: string, options?: { limit?: number }): Promise<EntityRelation[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db.prepare(
      "SELECT * FROM entity_relations WHERE source_entity_id = ? OR target_entity_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(entityId, entityId, options?.limit ?? 20) as RelationRow[];
    return rows.map(rowToRelation);
  }

  async getRelationsForMemory(memoryId: string): Promise<EntityRelation[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db.prepare("SELECT * FROM entity_relations WHERE memory_id = ?").all(memoryId) as RelationRow[];
    return rows.map(rowToRelation);
  }

  async searchEntities(query: string, options?: { limit?: number }): Promise<Entity[]> {
    const normalized = normalizeKey(query);
    using db = openSqliteDatabase(this.filePath);
    const rows = db.prepare("SELECT * FROM entities ORDER BY updated_at DESC").all() as EntityRow[];
    return rows
      .filter((row) => row.name.toLowerCase().includes(normalized) || parseJsonStringArray(row.aliases_json).some((alias) => alias.includes(normalized)))
      .slice(0, options?.limit ?? 20)
      .map(rowToEntity);
  }

  async listEntities(options?: { limit?: number }): Promise<Entity[]> {
    using db = openSqliteDatabase(this.filePath);
    const rows = db.prepare("SELECT * FROM entities ORDER BY updated_at DESC LIMIT ?").all(options?.limit ?? 100) as EntityRow[];
    return rows.map(rowToEntity);
  }
}

function findEntityRow(
  db: ReturnType<typeof openSqliteDatabase>,
  nameKey: string,
  aliases: string[],
): EntityRow | undefined {
  const rows = db.prepare("SELECT * FROM entities").all() as EntityRow[];
  return rows.find((row) => {
    const existingAliases = parseJsonStringArray(row.aliases_json);
    return row.name.toLowerCase() === nameKey || existingAliases.includes(nameKey) || aliases.some((alias) => row.name.toLowerCase() === alias || existingAliases.includes(alias));
  });
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    name: row.name,
    aliases: parseJsonStringArray(row.aliases_json),
    kind: row.kind as EntityKind,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLink(row: LinkRow): EntityLink {
  return {
    entityId: row.entity_id,
    memoryId: row.memory_id,
    relation: row.relation,
    confidence: Number(row.confidence),
    createdAt: row.created_at,
  };
}

function rowToRelation(row: RelationRow): EntityRelation {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relation: row.relation,
    memoryId: row.memory_id ?? undefined,
    confidence: Number(row.confidence),
    createdAt: row.created_at,
  };
}

function normalizeKey(value: string): string {
  return value.toLowerCase().trim();
}

function normalizeAliases(aliases: string[] | undefined): string[] {
  return [...new Set((aliases ?? []).map(normalizeKey).filter(Boolean))];
}
