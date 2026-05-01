# MarvMem API Reference

This document collects the API and configuration details that do not need to live in the README. For step-by-step integration examples, see [`USAGE.md`](USAGE.md).

## Core API

### Palace Memory

```ts
import { createMarvMem } from "marvmem";

const memory = createMarvMem({
  storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" },
});

const record = await memory.remember({
  scope: { type: "user", id: "alice" },
  kind: "preference",
  content: "User prefers concise replies in Chinese.",
  source: "manual",
  tags: ["language", "style"],
  metadata: { origin: "profile" },
});

const hits = await memory.search("reply style", {
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxResults: 5,
  minScore: 0.18,
});

const recall = await memory.recall({
  query: "How should I answer this user?",
  scopes: [{ type: "user", id: "alice" }],
  maxChars: 1000,
});

await memory.update(record.id, { content: "Updated content" });
await memory.forget(record.id);
```

`remember()` deduplicates by default. When an incoming record is merged, tags and metadata are merged, additional sources are kept in `metadata.sourceHistory`, and conflicting marker details are kept in `metadata.markerHistory`.

### Active Memory

```ts
await memory.active.distillContext({
  scope: { type: "task", id: "release-flow" },
  sessionSummary: "We are preparing release notes and QA handoff.",
});

await memory.active.distillExperience({
  scope: { type: "task", id: "release-flow" },
  newData: "Release checklists should be short and action-oriented.",
});

const context = await memory.active.read("context", { type: "task", id: "release-flow" });
const experience = await memory.active.read("experience", { type: "task", id: "release-flow" });
```

### Task Context

```ts
await memory.task.create({
  taskId: "release-flow",
  scope: { type: "task", id: "release-flow" },
  title: "Release flow",
});

await memory.task.appendEntry({
  taskId: "release-flow",
  role: "user",
  content: "We still need a final QA checklist.",
});

await memory.task.addDecision({
  taskId: "release-flow",
  content: "Keep the checklist short and action-oriented.",
});

const window = await memory.task.buildWindow({
  taskId: "release-flow",
  currentQuery: "What is left before release?",
  maxChars: 2000,
});
```

## Runtime API

```ts
import { createMemoryRuntime } from "marvmem/runtime";

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxRecallChars: 1200,
});

const capture = await runtime.captureTurn({
  taskId: "release-flow",
  taskTitle: "Release flow",
  userMessage: "Remember that I prefer concise Chinese replies.",
  assistantMessage: "Got it, I'll keep replies concise and in Chinese.",
});

const recall = await runtime.buildRecallContext({
  taskId: "release-flow",
  userMessage: "What did we decide about deployment?",
  maxChars: 1000,
});

await runtime.captureReflection({
  taskId: "release-flow",
  summary: "Adapter APIs should remain framework-agnostic.",
  scopes: [{ type: "task", id: "release-flow" }],
});
```

## Retrieval

### Builtin

Builtin retrieval is always available and uses deterministic local scoring.

| Factor | Default weight |
|--------|----------------|
| Lexical overlap | `0.45` |
| Hash embedding | `0.35` |
| Recency | `0.08` |
| Importance | `0.07` |
| Scope weight | `0.05` |

```ts
const result = await memory.retrieval.recall("release checklist", {
  scopes: [{ type: "task", id: "release-flow" }],
  maxChars: 1200,
});
```

### Remote Embeddings

Remote embeddings are opt-in. Setting an API key alone does not enable them.

| Provider | Env variable | Default model |
|----------|--------------|---------------|
| OpenAI | `OPENAI_API_KEY` | `text-embedding-3-small` |
| Gemini | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-embedding-001` |
| Voyage | `VOYAGE_API_KEY` | `voyage-4` |

```ts
const memory = createMarvMem({
  retrieval: {
    backend: "builtin",
    embeddings: { provider: "openai" },
  },
});
```

### QMD

```ts
const memory = createMarvMem({
  retrieval: {
    backend: "qmd",
    qmd: {
      enabled: true,
      command: "qmd",
      collections: [{ name: "memory", path: ".marvmem/qmd", pattern: "**/*.md" }],
      includeDefaultMemory: true,
    },
  },
});
```

## Maintenance

```ts
await memory.maintenance.attributeExperience({
  scope: { type: "task", id: "release-flow" },
  response: "I will keep the checklist concise and actionable.",
  outcome: "positive",
});

await memory.maintenance.calibrateExperience({
  scope: { type: "task", id: "release-flow" },
});

await memory.maintenance.rebuildExperience({
  scope: { type: "task", id: "release-flow" },
});

await memory.maintenance.deepConsolidate({
  scope: { type: "task", id: "release-flow" },
});
```

## MCP Tools

For custom hosts, `createMemoryMcpHandler()` exposes JSON-RPC 2.0 tools.

| Tool | Description |
|------|-------------|
| `memory_search` | Search palace records by query |
| `memory_get` | Fetch one record by id |
| `memory_list` | List records, optionally filtered by scope |
| `memory_write` | Persist a durable record |
| `memory_update` | Update an existing record by id |
| `memory_delete` | Delete a record by id |
| `memory_recall` | Build prompt-ready recall |
| `memory_retrieve` | Run the full retrieval stack |
| `memory_active_get` | Read active context and experience |
| `memory_active_distill` | Distill active context or experience |
| `memory_task_append` | Append entry to task context |
| `memory_task_window` | Build prompt-ready task context |
| `memory_maintenance_calibrate` | Run experience calibration |
| `memory_maintenance_rebuild` | Rebuild experience from palace fragments |

```ts
import { createMemoryMcpHandler } from "marvmem/mcp";

const handler = createMemoryMcpHandler({ memory });
const response = await handler.handleRequest(jsonRpcPayload);
```

Local stdio server:

```bash
npm run build
node dist/bin/marvmem-mcp.js
```

Useful environment variables:

```bash
MARVMEM_STORAGE_PATH="$HOME/.marvmem/memory.sqlite"
MARVMEM_SCOPE_TYPE=agent
MARVMEM_SCOPE_ID=codex
MARVMEM_RETRIEVAL_BACKEND=builtin
MARVMEM_EMBEDDINGS_PROVIDER=openai
MARVMEM_EMBEDDINGS_MODEL=text-embedding-3-small
```

## Adapters

| Adapter | Factory |
|---------|---------|
| Generic | `createGenericMemoryAdapter()` |
| Session flush | `createSessionMemoryAdapter()` |
| OpenClaw | `createOpenClawMemoryAdapter()` / `installOpenClawMemoryTakeover()` |
| Hermes | `createHermesAgentMemoryAdapter()` / `installHermesAgentMemoryTakeover()` |
| Marv | `createMarvMemoryAdapter()` |

Generic adapter:

```ts
import { createGenericMemoryAdapter } from "marvmem/adapters";

const adapter = createGenericMemoryAdapter({ memory });

const { systemHint, injectedContext } = await adapter.beforePrompt({
  userMessage: "How should I deploy this?",
});

await adapter.afterTurn({
  userMessage: "How should I deploy this?",
  assistantMessage: "I recommend using Railway for this project.",
});
```

OpenClaw and Hermes adapters can import existing markdown memory files once, treat SQLite as the source of truth, and mirror durable memory back to host markdown files.

## Local Agent Setup API

The `marvmem-agent` CLI manages Codex, Claude Code, Cursor, GitHub Copilot, and Antigravity setup. Details live in [`USAGE.md`](USAGE.md#12-mcp-的接入).

```bash
node dist/bin/marvmem-agent.js install all
node dist/bin/marvmem-agent.js ui
node dist/bin/marvmem-agent.js tui
```

When the UI server is running, it also exposes:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/agents/status` | `GET` | Agent setup status |
| `/v1/agents/install` | `POST` | Install one agent |
| `/v1/agents/import` | `POST` | Import one agent's sessions |
| `/v1/agents/install-all` | `POST` | Install all agents |
| `/v1/agents/import-all` | `POST` | Import all agent sessions |

## HTTP Memory Routes

The local HTTP server is project-key authenticated.

| Route | Method | Description |
|-------|--------|-------------|
| `/v1/memories` | `POST` | Create one memory |
| `/v1/memories` | `GET` | List memories |
| `/v1/memories/:id` | `GET` | Fetch one memory |
| `/v1/memories/:id` | `PATCH` | Update one memory |
| `/v1/memories/:id` | `DELETE` | Delete one memory |
| `/v1/memories/batch` | `POST` | Create many memories |
| `/v1/memories/batch` | `DELETE` | Delete many memories |
| `/v1/memories/export` | `GET` | Export JSON |
| `/v1/memories/:id/history` | `GET` | Inspect recent event history |

List filters include `kinds`, `tags`, and `metadata.<key>`.

## Configuration

```ts
const memory = createMarvMem({
  storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" },
  inferencer: async ({ kind, system, prompt, maxChars }) => ({
    ok: true,
    text: "...",
  }),
  retrieval: {
    backend: "builtin",
    embeddings: { provider: "auto" },
    qmd: { enabled: false },
  },
  active: {
    contextMaxChars: 400,
    experienceMaxChars: 800,
  },
  task: {
    recentEntriesLimit: 24,
    windowMaxChars: 4000,
    summaryMaxChars: 600,
  },
  dedupeThreshold: 0.85,
  embeddingDimensions: 128,
  searchWeights: {
    lexical: 0.45,
    hash: 0.35,
    recency: 0.08,
    importance: 0.07,
    scope: 0.05,
  },
});
```

## Package Exports

```text
marvmem
marvmem/core
marvmem/active
marvmem/task
marvmem/retrieval
marvmem/maintenance
marvmem/runtime
marvmem/mcp
marvmem/adapters
marvmem/system
marvmem/cloud
marvmem/platform
marvmem/http
marvmem/auth
marvmem/entity
marvmem/inspect
marvmem/bridge
marvmem/products/coding
marvmem/products/runtime
```

