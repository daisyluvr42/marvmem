# MarvMem

MarvMem is a small standalone long-term memory library extracted from Marv and packaged for reuse in other agents.

It gives you:

- durable memory records
- scope-aware search and recall
- prompt-ready injected context
- runtime helpers for capturing memories from turns
- an MCP tool surface
- thin adapters for agent frameworks

It does not depend on Marv's workspace Markdown memory, task-context store, or QMD sidecar.

## Highlights

- File-backed JSON storage by default
- In-memory storage for tests and ephemeral sessions
- Weighted search using lexical overlap, local hash similarity, recency, importance, and scope
- Automatic deduplication for near-identical writes
- Prompt-ready recall formatting with output length control
- MCP tools for search, read, write, update, delete, list, and recall

## Package Layout

MarvMem is split into three layers:

1. `core`: records, scopes, storage, search, recall
2. `runtime`: turn capture heuristics and reflection helpers
3. `mcp` and `adapters`: integration surfaces for agents

Available entrypoints:

- `marvmem`
- `marvmem/core`
- `marvmem/runtime`
- `marvmem/mcp`
- `marvmem/adapters`
- `marvmem/adapters/hermes-agent`
- `marvmem/adapters/openclaw`
- `marvmem/adapters/marv`

## Requirements

- Node.js `>= 20`
- ESM environment

## Install And Build

```bash
npm install
npm run build
```

For local verification:

```bash
npm run check
npm test
```

## Quick Start

```ts
import { createMarvMem } from "marvmem";
import { createMemoryRuntime } from "marvmem/runtime";

const memory = createMarvMem({
  storagePath: ".marvmem/memory.json",
});

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [
    { type: "agent", id: "assistant", weight: 1 },
    { type: "user", id: "alice", weight: 1.05 },
  ],
});

await runtime.captureTurn({
  userMessage: "Remember that I prefer concise Chinese replies.",
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
});

const recall = await runtime.buildRecallContext({
  userMessage: "How should I answer this user?",
  maxChars: 800,
});

console.log(recall.injectedContext);
```

## Core Concepts

### Memory Scopes

Every record belongs to a scope:

- `agent`
- `session`
- `user`
- `task`
- `document`

Example:

```ts
const scope = { type: "user", id: "alice", weight: 1.05 };
```

`weight` is optional and is only used when ranking scoped search results.

### Memory Records

A memory record stores:

- `id`
- `scope`
- `kind`
- `content`
- `summary`
- `confidence`
- `importance`
- `source`
- `tags`
- `metadata`
- `createdAt`
- `updatedAt`

## Core API

### Create A Memory Store

```ts
import { createMarvMem } from "marvmem";

const memory = createMarvMem({
  storagePath: ".marvmem/memory.json",
  dedupeThreshold: 0.85,
});
```

Options:

- `storagePath`: JSON file used by the default file store
- `store`: custom storage implementation
- `idFactory`: custom ID generator
- `now`: inject a clock for testing
- `embeddingDimensions`: hash-vector size, default `128`
- `dedupeThreshold`: merge near-identical writes when similarity reaches this threshold
- `searchWeights`: override ranking weights

### Write A Memory

```ts
await memory.remember({
  scope: { type: "user", id: "alice" },
  kind: "preference",
  content: "User prefers concise replies in Chinese.",
  importance: 0.9,
  tags: ["language", "style"],
  source: "manual",
});
```

### Search Memories

```ts
const hits = await memory.search("reply language preference", {
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxResults: 5,
});

for (const hit of hits) {
  console.log(hit.score, hit.record.content, hit.reasons);
}
```

Each hit includes:

- `record`
- `score`
- `reasons.lexical`
- `reasons.hash`
- `reasons.recency`
- `reasons.importance`
- `reasons.scope`
- `snippet`

### Recall Prompt Context

```ts
const recall = await memory.recall({
  query: "How should I answer this user?",
  recentMessages: [
    "We were discussing answer style.",
    "The user asked for a short response.",
  ],
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxChars: 1000,
});

console.log(recall.query);
console.log(recall.injectedContext);
```

### Read, List, Update, And Delete

```ts
const record = await memory.get("memory-id");

const records = await memory.list({
  scopes: [{ type: "user", id: "alice" }],
  limit: 20,
});

const updated = await memory.update("memory-id", {
  content: "User prefers concise replies in Chinese.",
  importance: 1,
});

const deleted = await memory.forget("memory-id");
```

## Runtime API

`createMemoryRuntime()` adds higher-level flows on top of the core store.

```ts
import { createMemoryRuntime } from "marvmem/runtime";

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [{ type: "task", id: "support-bot", weight: 1 }],
  maxRecallChars: 1200,
});
```

### `buildRecallContext()`

Searches memory and returns prompt-ready recall text.

```ts
const recall = await runtime.buildRecallContext({
  userMessage: "What did we decide about deployment?",
  recentMessages: ["We were comparing Fly.io and Railway."],
  maxChars: 600,
});
```

### `captureTurn()`

Infers durable memories from a user turn and stores them under the resolved scope.

```ts
const capture = await runtime.captureTurn({
  userMessage: "Remember that I prefer concise Chinese replies.",
});

console.log(capture.proposals);
console.log(capture.stored);
```

Current heuristics infer memories for:

- explicit remember requests
- preferences
- decisions
- identity statements

### `captureReflection()`

Stores a reflection or learned summary as an `experience` memory.

```ts
await runtime.captureReflection({
  summary: "We decided the adapter API should stay framework-agnostic.",
  scopes: [{ type: "task", id: "marvmem" }],
  tags: ["design"],
});
```

## MCP API

`createMemoryMcpHandler()` exposes a small JSON-RPC handler with MCP-compatible tool methods.

```ts
import { createMemoryMcpHandler } from "marvmem/mcp";

const handler = createMemoryMcpHandler({ memory });
```

Supported methods:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

Available tools:

- `memory_search`
- `memory_get`
- `memory_list`
- `memory_write`
- `memory_update`
- `memory_delete`
- `memory_recall`

Example `tools/call` request:

```ts
const response = await handler.handleRequest({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "memory_write",
    arguments: {
      content: "User prefers concise Chinese replies.",
      kind: "preference",
      scopeType: "user",
      scopeId: "alice",
      importance: 0.9,
    },
  },
});
```

`memory_recall` accepts:

- `message`
- `recentMessages`
- `scopeType`
- `scopeId`
- `maxChars`

## Adapters

The adapter layer wraps the runtime into a small framework-friendly shape:

- `tools`
- `beforePrompt()`
- `afterTurn()`

### Hermes Agent Adapter

```ts
import { createMarvMem } from "marvmem";
import { createHermesAgentMemoryAdapter } from "marvmem/adapters/hermes-agent";

const memory = createMarvMem({ storagePath: ".marvmem/memory.json" });
const adapter = createHermesAgentMemoryAdapter({
  memory,
  defaultScopes: [{ type: "agent", id: "hermes", weight: 1 }],
});

const promptMemory = await adapter.beforePrompt({
  userMessage: "What did we decide about deployment?",
});

const systemPrompt = [promptMemory.systemHint, promptMemory.injectedContext]
  .filter(Boolean)
  .join("\n\n");
```

### OpenClaw Adapter

```ts
import { createMarvMem } from "marvmem";
import { createOpenClawMemoryAdapter } from "marvmem/adapters/openclaw";

const memory = createMarvMem({ storagePath: ".marvmem/memory.json" });
const adapter = createOpenClawMemoryAdapter({
  memory,
  defaultScopes: [{ type: "task", id: "agent-loop", weight: 1 }],
});

await adapter.afterTurn({
  userMessage: "Remember that we should keep the API easy to integrate.",
});
```

### Marv Adapter

```ts
import { createMarvMemoryAdapter } from "marvmem/adapters/marv";

const adapter = createMarvMemoryAdapter({
  memory,
  defaultScopes: [{ type: "task", id: "marv", weight: 1 }],
});
```

## Storage

By default, MarvMem uses a file-backed JSON store at the path you provide.

For tests or temporary sessions, use the in-memory store:

```ts
import { createMarvMem, InMemoryStore } from "marvmem";

const memory = createMarvMem({
  store: new InMemoryStore(),
});
```

You can also provide your own `MemoryStore` with `load()` and `save()`.

## Development

```bash
npm install
npm run check
npm run build
npm test
```

## Limitations

- Storage is JSON-based, not SQLite-based.
- Search uses deterministic local hash embeddings plus lexical scoring, not remote embeddings.
- Runtime capture is heuristic and intentionally simple.
- Adapters are intentionally thin because upstream agent APIs may evolve.

## Usage Guide

See [docs/USAGE.md](https://github.com/daisyluvr42/marvmem/blob/main/docs/USAGE.md) for a step-by-step usage guide.
