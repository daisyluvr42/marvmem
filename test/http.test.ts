import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createMarvMem } from "../src/core/memory.js";
import { MarvMemPlatformService } from "../src/platform/service.js";
import { ProjectStore } from "../src/auth/project.js";
import { generateApiKey, hashApiKey, isValidApiKeyFormat, apiKeyPrefix } from "../src/auth/keys.js";
import { createMarvMemServer } from "../src/http/server.js";
import { InMemoryInspectEventStore } from "../src/inspect/store.js";

// ---------------------------------------------------------------------------
// Auth / keys
// ---------------------------------------------------------------------------

describe("auth/keys", () => {
  it("generates a valid API key", () => {
    const key = generateApiKey();
    assert.ok(key.startsWith("mm_"));
    assert.ok(key.length >= 20);
    assert.ok(isValidApiKeyFormat(key));
  });

  it("hashes a key deterministically", () => {
    const key = "mm_test123456789012345678";
    const h1 = hashApiKey(key);
    const h2 = hashApiKey(key);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 hex
  });

  it("rejects invalid key formats", () => {
    assert.equal(isValidApiKeyFormat("invalid"), false);
    assert.equal(isValidApiKeyFormat("mm_"), false);
    assert.equal(isValidApiKeyFormat("mm_short"), false);
  });

  it("returns a visible prefix", () => {
    const prefix = apiKeyPrefix("mm_abcdef123456789");
    assert.equal(prefix, "mm_abcdef123");
  });
});

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------

describe("ProjectStore", () => {
  it("creates and resolves a project", () => {
    const store = new ProjectStore();
    const { project, apiKey } = store.create("Test Project");
    assert.ok(project.id.startsWith("proj_"));
    assert.equal(project.name, "Test Project");

    const resolved = store.resolveKey(apiKey);
    assert.ok(resolved);
    assert.equal(resolved.id, project.id);
  });

  it("returns null for invalid key", () => {
    const store = new ProjectStore();
    assert.equal(store.resolveKey("mm_nonexistent0000000000"), null);
  });

  it("rotates API key", () => {
    const store = new ProjectStore();
    const { project, apiKey: oldKey } = store.create("Rotate Test");
    const newKey = store.rotateKey(project.id);
    assert.ok(newKey);
    assert.notEqual(newKey, oldKey);

    // Old key no longer works
    assert.equal(store.resolveKey(oldKey), null);

    // New key works
    const resolved = store.resolveKey(newKey);
    assert.ok(resolved);
    assert.equal(resolved.id, project.id);
  });
});

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

describe("MarvMem HTTP API", () => {
  let apiKey: string;
  let projectId: string;
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const memory = createMarvMem({ storage: { backend: "memory" } });
    const events = new InMemoryInspectEventStore();
    const platform = new MarvMemPlatformService({ memory, events });
    const projects = new ProjectStore();
    const { apiKey: key, project } = projects.create("HTTP Test");
    apiKey = key;
    projectId = project.id;

    // Use random port
    const port = 10000 + Math.floor(Math.random() * 50000);
    const server = createMarvMemServer({
      platform,
      projects,
      events,
      port,
    });
    await server.listen();
    baseUrl = server.address;
    close = server.close;
  });

  afterEach(async () => {
    await close();
  });

  async function api(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("Content-Type", "application/json");
    return fetch(`${baseUrl}${path}`, { ...options, headers });
  }

  it("GET /v1/health returns ok without auth", async () => {
    const res = await fetch(`${baseUrl}/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
  });

  it("rejects requests without API key", async () => {
    const res = await fetch(`${baseUrl}/v1/memories`);
    assert.equal(res.status, 401);
  });

  it("GET /v1/me/project returns project info", async () => {
    const res = await api("/v1/me/project");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok((body.id as string).startsWith("proj_"));
    assert.equal(body.name, "HTTP Test");
  });

  it("POST + GET + PATCH + DELETE /v1/memories lifecycle", async () => {
    // Create
    const createRes = await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "The sky is blue.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as Record<string, unknown>;
    const id = created.id as string;
    assert.ok(id);

    // Get
    const getRes = await api(`/v1/memories/${id}`);
    assert.equal(getRes.status, 200);
    const got = (await getRes.json()) as Record<string, unknown>;
    assert.equal(got.content, "The sky is blue.");

    // Update
    const patchRes = await api(`/v1/memories/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "The sky is red at sunset." }),
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as Record<string, unknown>;
    assert.equal(patched.content, "The sky is red at sunset.");

    // Delete
    const deleteRes = await api(`/v1/memories/${id}`, {
      method: "DELETE",
    });
    assert.equal(deleteRes.status, 204);

    // Verify deleted
    const getAfterDelete = await api(`/v1/memories/${id}`);
    assert.equal(getAfterDelete.status, 404);
  });

  it("ignores caller-supplied projectId on POST /v1/memories", async () => {
    const createRes = await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        context: { projectId: "proj_override" },
        kind: "fact",
        content: "Bound to auth project.",
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as Record<string, unknown>;
    const scope = created.scope as Record<string, unknown>;
    assert.equal(scope.type, "project");
    assert.equal(scope.id, projectId);
  });

  it("GET /v1/memories returns a list", async () => {
    // Write a memory first
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({ kind: "fact", content: "A test fact." }),
    });

    const res = await api("/v1/memories?limit=10");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(Array.isArray(body.memories));
    assert.ok((body.memories as unknown[]).length > 0);
  });

  it("filters memories by tags and metadata", async () => {
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "Tagged memory.",
        tags: ["release"],
        metadata: { area: "deploy" },
      }),
    });
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "Other memory.",
        tags: ["docs"],
        metadata: { area: "docs" },
      }),
    });

    const res = await api("/v1/memories?tags=release&metadata.area=deploy");
    const body = (await res.json()) as Record<string, unknown>;
    const memories = body.memories as Array<Record<string, unknown>>;
    assert.equal(memories.length, 1);
    assert.equal(memories[0]!.content, "Tagged memory.");
  });

  it("supports batch create, history, and export", async () => {
    const batchRes = await api("/v1/memories/batch", {
      method: "POST",
      body: JSON.stringify({
        memories: [
          { kind: "fact", content: "Batch one." },
          { kind: "fact", content: "Batch two." },
        ],
      }),
    });
    assert.equal(batchRes.status, 201);
    const batch = (await batchRes.json()) as Record<string, unknown>;
    const memories = batch.memories as Array<Record<string, unknown>>;
    assert.equal(memories.length, 2);

    const historyRes = await api(`/v1/memories/${memories[0]!.id}/history`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as Record<string, unknown>;
    assert.ok((history.events as unknown[]).length >= 1);

    const exportRes = await api("/v1/memories/export");
    assert.equal(exportRes.status, 200);
    const exported = (await exportRes.json()) as Record<string, unknown>;
    assert.ok((exported.count as number) >= 2);

    const deleteRes = await api("/v1/memories/batch", {
      method: "DELETE",
      body: JSON.stringify({ ids: memories.map((memory) => memory.id) }),
    });
    const deleted = (await deleteRes.json()) as Record<string, unknown>;
    assert.equal(deleted.deleted, 2);
  });

  it("POST /v1/recall builds recall context", async () => {
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "repo_convention",
        content: "This project uses pnpm for package management.",
      }),
    });

    const res = await api("/v1/recall", {
      method: "POST",
      body: JSON.stringify({
        message: "How do I install packages?",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof body.injectedContext === "string");
  });

  it("ignores caller-supplied projectId on POST /v1/recall", async () => {
    await api("/v1/memories", {
      method: "POST",
      body: JSON.stringify({
        kind: "fact",
        content: "Install dependencies with pnpm install.",
      }),
    });

    const res = await api("/v1/recall", {
      method: "POST",
      body: JSON.stringify({
        context: { projectId: "proj_override" },
        message: "How do I install dependencies?",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(String(body.injectedContext).includes("pnpm install"));
  });

  it("POST /v1/turns/capture captures a turn", async () => {
    const res = await api("/v1/turns/capture", {
      method: "POST",
      body: JSON.stringify({
        userMessage: "Remember to use TypeScript strict mode.",
        assistantMessage: "Understood.",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(typeof body.proposals === "number");
    assert.ok(typeof body.stored === "number");
  });

  it("ignores caller-supplied projectId on POST /v1/turns/capture", async () => {
    const captureRes = await api("/v1/turns/capture", {
      method: "POST",
      body: JSON.stringify({
        context: { projectId: "proj_override" },
        userMessage: "Remember that this project uses strict TypeScript.",
      }),
    });
    assert.equal(captureRes.status, 200);

    const listRes = await api("/v1/memories?limit=10");
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as Record<string, unknown>;
    const memories = listBody.memories as Array<Record<string, unknown>>;
    assert.ok(memories.some((memory) => String(memory.content).includes("strict TypeScript")));
  });
});
