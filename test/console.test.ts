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

describe("Console API routes", () => {
  let apiKey: string;
  let projectId: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  let agentHome: string;

  beforeEach(async () => {
    const memory = createMarvMem({ storage: { backend: "memory" } });
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
