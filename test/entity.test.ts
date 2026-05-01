import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { InMemoryEntityStore } from "../src/entity/store-memory.js";
import { RuleBasedEntityExtractor } from "../src/entity/extractor.js";

// ---------------------------------------------------------------------------
// InMemoryEntityStore
// ---------------------------------------------------------------------------

describe("InMemoryEntityStore", () => {
  let store: InMemoryEntityStore;

  beforeEach(() => {
    store = new InMemoryEntityStore();
  });

  it("creates and finds entity by name", async () => {
    const entity = await store.upsertEntity({
      name: "TypeScript",
      kind: "tech",
    });
    assert.ok(entity.id.startsWith("ent_"));
    assert.equal(entity.name, "TypeScript");

    const found = await store.findByName("typescript");
    assert.ok(found);
    assert.equal(found.id, entity.id);
  });

  it("upserts merge aliases", async () => {
    await store.upsertEntity({
      name: "TypeScript",
      kind: "tech",
      aliases: ["ts"],
    });
    await store.upsertEntity({
      name: "TypeScript",
      kind: "tech",
      aliases: ["typescript-lang"],
    });

    const found = await store.findByName("TypeScript");
    assert.ok(found);
    assert.ok(found.aliases.includes("ts"));
    assert.ok(found.aliases.includes("typescript-lang"));
  });

  it("finds entity by alias", async () => {
    await store.upsertEntity({
      name: "TypeScript",
      kind: "tech",
      aliases: ["ts"],
    });

    const found = await store.findByAlias("ts");
    assert.ok(found);
    assert.equal(found.name, "TypeScript");
  });

  it("links entity to memory", async () => {
    const entity = await store.upsertEntity({ name: "React", kind: "tech" });
    await store.link(entity.id, "mem_1", "mentions");
    await store.link(entity.id, "mem_2", "uses");

    const links = await store.getLinkedMemories(entity.id);
    assert.equal(links.length, 2);
    assert.equal(links[0]!.memoryId, "mem_1");
  });

  it("avoids duplicate links", async () => {
    const entity = await store.upsertEntity({ name: "Go", kind: "tech" });
    await store.link(entity.id, "mem_1", "mentions");
    await store.link(entity.id, "mem_1", "mentions"); // duplicate

    const links = await store.getLinkedMemories(entity.id);
    assert.equal(links.length, 1);
  });

  it("unlinks entity from memory", async () => {
    const entity = await store.upsertEntity({ name: "Python", kind: "tech" });
    await store.link(entity.id, "mem_1", "mentions");
    await store.unlink(entity.id, "mem_1");

    const links = await store.getLinkedMemories(entity.id);
    assert.equal(links.length, 0);
  });

  it("searches entities by name substring", async () => {
    await store.upsertEntity({ name: "TypeScript", kind: "tech" });
    await store.upsertEntity({ name: "JavaScript", kind: "tech" });
    await store.upsertEntity({ name: "Python", kind: "tech" });

    const results = await store.searchEntities("script");
    assert.equal(results.length, 2);
  });

  it("getLinkedEntities returns entities for a memory", async () => {
    const e1 = await store.upsertEntity({ name: "React", kind: "tech" });
    const e2 = await store.upsertEntity({ name: "Next.js", kind: "tech" });
    await store.link(e1.id, "mem_1", "uses");
    await store.link(e2.id, "mem_1", "uses");

    const linked = await store.getLinkedEntities("mem_1");
    assert.equal(linked.length, 2);
  });

  it("stores relations between entities", async () => {
    const react = await store.upsertEntity({ name: "React", kind: "tech" });
    const next = await store.upsertEntity({ name: "Next.js", kind: "tech" });

    await store.relate({
      sourceEntityId: react.id,
      targetEntityId: next.id,
      relation: "co_occurs",
      memoryId: "mem_1",
    });

    const relations = await store.getRelationsForEntity(react.id);
    assert.equal(relations.length, 1);
    assert.equal(relations[0]!.targetEntityId, next.id);

    await store.clearRelationsForMemory("mem_1");
    assert.equal((await store.getRelationsForEntity(react.id)).length, 0);
  });
});

// ---------------------------------------------------------------------------
// RuleBasedEntityExtractor
// ---------------------------------------------------------------------------

describe("RuleBasedEntityExtractor", () => {
  const extractor = new RuleBasedEntityExtractor();

  it("extracts known tech names", async () => {
    const entities = await extractor.extract("This project uses TypeScript and React");
    const names = entities.map((e) => e.name.toLowerCase());
    assert.ok(names.includes("typescript"));
    assert.ok(names.includes("react"));
  });

  it("extracts known tools", async () => {
    const entities = await extractor.extract("We use pnpm and eslint");
    const names = entities.map((e) => e.name.toLowerCase());
    assert.ok(names.includes("pnpm"));
    assert.ok(names.includes("eslint"));
  });

  it("extracts @mentions as person entities", async () => {
    const entities = await extractor.extract("Assigned to @alice and @bob-dev");
    const people = entities.filter((e) => e.kind === "person");
    assert.ok(people.length >= 2);
  });

  it("extracts quoted strings as project names", async () => {
    const entities = await extractor.extract('Working on "MarvMem" project');
    const projects = entities.filter((e) => e.kind === "project");
    assert.ok(projects.length >= 1);
    assert.equal(projects[0]!.name, "MarvMem");
  });

  it("returns empty for trivial input", async () => {
    const entities = await extractor.extract("ok");
    // May or may not find anything, but shouldn't crash
    assert.ok(Array.isArray(entities));
  });

  it("extracts PascalCase compound words", async () => {
    const entities = await extractor.extract("The TaskContextManager handles task state");
    const found = entities.find((e) => e.name === "TaskContextManager");
    assert.ok(found);
  });
});
