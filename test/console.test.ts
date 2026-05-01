import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarvMem } from "../src/core/memory.js";
import { MarvMemPlatformService } from "../src/platform/service.js";
import { InMemoryInspectEventStore } from "../src/inspect/store.js";
import { ProjectStore } from "../src/auth/project.js";
import { createMarvMemServer } from "../src/http/server.js";
import type { MarvMem } from "../src/core/memory.js";

describe("Console API routes", () => {
  let apiKey: string;
  let projectId: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  let agentHome: string;
  let memory: MarvMem;
  let agentMemoryId: string;

  beforeEach(async () => {
    memory = createMarvMem({ storage: { backend: "memory" } });
    const events = new InMemoryInspectEventStore();
    const platform = new MarvMemPlatformService({ memory, events });
    const projects = new ProjectStore();
    const { apiKey: key, project } = projects.create("Console Test");
    apiKey = key;
    projectId = project.id;
    agentHome = await mkdtemp(join(tmpdir(), "marvmem-console-agents-"));

    const port = 10000 + Math.floor(Math.random() * 50000);
    const server = createMarvMemServer({
      platform,
      projects,
      events,
      port,
      consolePath: "src/console",
      agents: {
        home: agentHome,
        storagePath: join(agentHome, "memory.sqlite"),
        mcpPath: join(agentHome, "marvmem-mcp.js"),
      },
    });
    await server.listen();
    baseUrl = server.address;
    close = server.close;

    // Seed data via HTTP (so projectId is bound by auth)
    await apiFetch("/v1/memories", {
      method: "POST",
      body: JSON.stringify({ kind: "fact", content: "TypeScript is used for this project", tags: ["tech"] }),
    });
    await apiFetch("/v1/memories", {
      method: "POST",
      body: JSON.stringify({ kind: "preference", content: "User prefers dark mode", tags: ["ui"] }),
    });
    const agentRecord = await memory.remember({
      scope: { type: "agent", id: "codex" },
      kind: "note",
      content: "Codex imported session remembers shared console visibility",
      source: "codex_session_import",
      tags: ["codex", "session"],
    });
    agentMemoryId = agentRecord.id;
  });

  afterEach(async () => {
    await close();
    await rm(agentHome, { recursive: true, force: true });
  });

  async function apiFetch(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    headers.set("Content-Type", "application/json");
    return fetch(`${baseUrl}${path}`, { ...options, headers });
  }

  it("GET /v1/stats returns aggregated statistics", async () => {
    const res = await apiFetch("/v1/stats");
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.totalMemories, 2);
    const kinds = data.kinds as Record<string, number>;
    assert.ok(kinds.fact >= 1);
    assert.ok(kinds.preference >= 1);
  });

  it("GET /v1/stats?view=shared includes agent-scoped memories", async () => {
    const res = await apiFetch("/v1/stats?view=shared");
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.totalMemories, 3);
    const scopes = data.scopes as Record<string, number>;
    assert.equal(scopes["agent:codex"], 1);
  });

  it("GET /v1/memories keeps project-only default and supports shared view", async () => {
    const projectRes = await apiFetch("/v1/memories?limit=10");
    assert.equal(projectRes.status, 200);
    const projectData = (await projectRes.json()) as Record<string, unknown>;
    assert.equal((projectData.memories as unknown[]).length, 2);

    const sharedRes = await apiFetch("/v1/memories?view=shared&limit=10");
    assert.equal(sharedRes.status, 200);
    const sharedData = (await sharedRes.json()) as Record<string, unknown>;
    const memories = sharedData.memories as Array<Record<string, unknown>>;
    assert.equal(memories.length, 3);
    assert.ok(memories.some((record) => (record.scope as Record<string, unknown>).id === "codex"));
  });

  it("GET /v1/events returns paginated events", async () => {
    const res = await apiFetch("/v1/events?limit=10");
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    const events = data.events as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(events));
    // We wrote 2 memories → 2 memory_written events
    assert.ok(events.length >= 2);
    assert.equal(events[0].type, "memory_written");
  });

  it("GET /v1/events filters by type", async () => {
    const res = await apiFetch("/v1/events?type=memory_deleted");
    const data = (await res.json()) as Record<string, unknown>;
    const events = data.events as unknown[];
    assert.equal(events.length, 0);
  });

  it("POST /v1/inspect/recall returns layered recall", async () => {
    const res = await apiFetch("/v1/inspect/recall", {
      method: "POST",
      body: JSON.stringify({ message: "What tech is used?" }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok("injectedContext" in data);
  });

  it("POST /v1/inspect/recall?view=shared can recall agent-scoped memories", async () => {
    const res = await apiFetch("/v1/inspect/recall?view=shared", {
      method: "POST",
      body: JSON.stringify({ message: "shared console visibility" }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    const hits = data.hits as Array<Record<string, unknown>>;
    assert.ok(hits.some((hit) => ((hit.record as Record<string, unknown>).scope as Record<string, unknown>).id === "codex"));
  });

  it("DELETE /v1/memories/:id?view=shared can manage agent-scoped memories without changing default visibility", async () => {
    const missing = await apiFetch(`/v1/memories/${agentMemoryId}`, { method: "DELETE" });
    assert.equal(missing.status, 404);

    const deleted = await apiFetch(`/v1/memories/${agentMemoryId}?view=shared`, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.equal(await memory.get(agentMemoryId), null);
  });

  it("GET /v1/agents/status returns local agent setup state", async () => {
    const res = await apiFetch("/v1/agents/status");
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    assert.equal(data.storagePath, join(agentHome, "memory.sqlite"));
    const agents = data.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 5);
    const codex = agents.find((agent) => agent.agent === "codex");
    assert.ok(codex);
    assert.equal((codex.sessions as Record<string, unknown>).rootExists, false);
  });

  it("GET /console serves the console HTML", async () => {
    const res = await fetch(`${baseUrl}/console`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("MarvMem Console"));
  });

  it("GET /console/ also serves index.html", async () => {
    const res = await fetch(`${baseUrl}/console/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("MarvMem Console"));
  });
});
