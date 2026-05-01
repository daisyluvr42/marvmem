import { randomUUID } from "node:crypto";
import type {
  Entity,
  EntityKind,
  EntityLink,
  EntityRelation,
  EntityStore,
} from "./types.js";

// ---------------------------------------------------------------------------
// In-memory entity store (testing + dev)
// ---------------------------------------------------------------------------

export class InMemoryEntityStore implements EntityStore {
  private readonly entities = new Map<string, Entity>();
  private readonly links: EntityLink[] = [];
  private readonly relations: EntityRelation[] = [];

  async upsertEntity(input: {
    name: string;
    aliases?: string[];
    kind: EntityKind;
    metadata?: Record<string, unknown>;
  }): Promise<Entity> {
    const normalized = input.name.toLowerCase().trim();

    // Check if entity already exists by name or alias (get the actual map entry)
    let existingId: string | null = null;
    for (const [id, entity] of this.entities.entries()) {
      if (
        entity.name.toLowerCase() === normalized ||
        entity.aliases.some((a) => a === normalized)
      ) {
        existingId = id;
        break;
      }
    }

    if (existingId) {
      const existing = this.entities.get(existingId)!;
      // Merge aliases
      const newAliases = new Set([
        ...existing.aliases.map((a) => a.toLowerCase()),
        ...(input.aliases ?? []).map((a) => a.toLowerCase().trim()).filter(Boolean),
      ]);
      existing.aliases = [...newAliases];
      existing.updatedAt = new Date().toISOString();
      if (input.metadata) {
        existing.metadata = { ...existing.metadata, ...input.metadata };
      }
      return { ...existing };
    }

    const entity: Entity = {
      id: `ent_${randomUUID().slice(0, 8)}`,
      name: input.name.trim(),
      aliases: [...new Set((input.aliases ?? []).map((a) => a.toLowerCase().trim()).filter(Boolean))],
      kind: input.kind,
      metadata: input.metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.entities.set(entity.id, entity);
    return { ...entity };
  }

  async findByName(name: string): Promise<Entity | null> {
    const normalized = name.toLowerCase().trim();
    for (const entity of this.entities.values()) {
      if (entity.name.toLowerCase() === normalized) {
        return { ...entity };
      }
    }
    return null;
  }

  async findByAlias(alias: string): Promise<Entity | null> {
    const normalized = alias.toLowerCase().trim();
    for (const entity of this.entities.values()) {
      if (entity.aliases.some((a) => a === normalized)) {
        return { ...entity };
      }
    }
    return null;
  }

  async getEntity(id: string): Promise<Entity | null> {
    const entity = this.entities.get(id);
    return entity ? { ...entity } : null;
  }

  async link(
    entityId: string,
    memoryId: string,
    relation: string,
    confidence = 1.0,
  ): Promise<void> {
    // Avoid duplicate links
    const exists = this.links.some(
      (l) => l.entityId === entityId && l.memoryId === memoryId && l.relation === relation,
    );
    if (exists) return;

    this.links.push({
      entityId,
      memoryId,
      relation,
      confidence,
      createdAt: new Date().toISOString(),
    });
  }

  async unlink(entityId: string, memoryId: string): Promise<void> {
    const idx = this.links.findIndex(
      (l) => l.entityId === entityId && l.memoryId === memoryId,
    );
    if (idx !== -1) {
      this.links.splice(idx, 1);
    }
  }

  async relate(input: {
    sourceEntityId: string;
    targetEntityId: string;
    relation: string;
    memoryId?: string;
    confidence?: number;
  }): Promise<EntityRelation> {
    const existing = this.relations.find(
      (relation) =>
        relation.sourceEntityId === input.sourceEntityId &&
        relation.targetEntityId === input.targetEntityId &&
        relation.relation === input.relation &&
        relation.memoryId === input.memoryId,
    );
    if (existing) {
      return { ...existing };
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
    this.relations.push(relation);
    return { ...relation };
  }

  async clearRelationsForMemory(memoryId: string): Promise<void> {
    for (let i = this.relations.length - 1; i >= 0; i--) {
      if (this.relations[i]!.memoryId === memoryId) {
        this.relations.splice(i, 1);
      }
    }
  }

  async getLinkedMemories(entityId: string): Promise<EntityLink[]> {
    return this.links.filter((l) => l.entityId === entityId);
  }

  async getLinkedEntities(memoryId: string): Promise<EntityLink[]> {
    return this.links.filter((l) => l.memoryId === memoryId);
  }

  async getRelationsForEntity(entityId: string, options?: { limit?: number }): Promise<EntityRelation[]> {
    const limit = options?.limit ?? 20;
    return this.relations
      .filter((relation) => relation.sourceEntityId === entityId || relation.targetEntityId === entityId)
      .slice(0, limit)
      .map((relation) => ({ ...relation }));
  }

  async getRelationsForMemory(memoryId: string): Promise<EntityRelation[]> {
    return this.relations
      .filter((relation) => relation.memoryId === memoryId)
      .map((relation) => ({ ...relation }));
  }

  async searchEntities(query: string, options?: { limit?: number }): Promise<Entity[]> {
    const limit = options?.limit ?? 20;
    const normalized = query.toLowerCase().trim();
    const results: Entity[] = [];

    for (const entity of this.entities.values()) {
      if (
        entity.name.toLowerCase().includes(normalized) ||
        entity.aliases.some((a) => a.includes(normalized))
      ) {
        results.push({ ...entity });
      }
    }

    return results.slice(0, limit);
  }

  async listEntities(options?: { limit?: number }): Promise<Entity[]> {
    const limit = options?.limit ?? 100;
    return [...this.entities.values()].slice(0, limit).map((e) => ({ ...e }));
  }
}
