# Full Memory Subsystem Design

## Goal

Turn `marvmem` from a lightweight long-term memory helper into a full reusable memory subsystem extracted from Marv, while removing Marv-specific agent/runtime coupling.

The extracted subsystem should keep the parts that make Marv memory distinctive:

- `Memory Palace`: full retained long-term memory
- `Active Memory`: LLM-compressed derived memory
- `Task Context`: active working set assembly
- `Hybrid Retrieval`: lexical + vector retrieval
- `QMD Backend`: optional external retrieval backend
- `Maintenance Lifecycle`: distillation, attribution, calibration, rebuild

## Scope

### Included

- SQLite-backed structured memory storage
- Palace memory CRUD and recall
- Active context and active experience documents
- Task-context entries, summary, decisions, and context window assembly
- Builtin hybrid retrieval
- Remote embedding providers
- Optional QMD retrieval backend
- Attribution, weekly calibration, and rebuild flows
- Runtime orchestration across all layers
- MCP/adapters/docs updates

### Excluded

- Marv session-key semantics
- Goal-loop specific triggers
- Compaction-specific triggers
- Marv config and provider registries
- Workspace markdown source-of-truth compatibility

## Architecture

### Layers

1. `palace`
Structured long-term memory store. Full retention, scoped recall, maintenance metadata, and retrieval surfaces.

2. `active`
Derived memory layer with:

- `context`: compressed current working context
- `experience`: compressed reusable lessons and strategies

3. `task`
Task-local working memory:

- rolling summary
- recent entries
- key decisions
- context window builder

4. `retrieval`

- builtin hybrid search
- remote embedding providers
- optional QMD backend

5. `runtime`
Orchestrates recall and memory maintenance:

- palace recall
- active recall
- task window assembly
- overflow/task reflection capture

## Storage Plan

Default backend becomes SQLite at `.marvmem/memory.sqlite`.

Planned tables:

- `memory_items`
- `memory_items_fts`
- `memory_items_vec`
- `memory_archive`
- `active_documents`
- `task_context`
- `task_context_entries`
- `task_context_state`
- `task_context_bookmarks`

JSON file storage is retained only as a fallback/demo backend.

## Public API

```ts
const mem = createMarvMem({
  storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" },
  inferencer,
  retrieval: {
    backend: "builtin",
    embeddings: { provider: "openai" },
  },
});

await mem.palace.remember(...);
await mem.active.distillContext(...);
await mem.active.distillExperience(...);
await mem.task.appendEntry(...);
const recall = await mem.runtime.buildRecallContext(...);
```

## Inferencer Contract

```ts
type MemoryInferencer = (input: {
  kind: "context" | "experience" | "task_summary" | "attribution" | "calibration";
  system: string;
  prompt: string;
  maxChars?: number;
  currentContent?: string;
}) => Promise<
  | { ok: true; text: string }
  | { ok: false; error?: string }
>;
```

## Retrieval Plan

### Builtin

- lexical/FTS retrieval
- vector retrieval
- hybrid merge + ranking
- current hash embedding fallback remains available

### Remote embedding providers

- OpenAI
- Gemini
- Voyage

### Optional backend

- QMD manager, isolated from Marv-specific config

## Maintenance Plan

### Distillation

- active context distillation
- active experience distillation

### Attribution

- detect which experience entries influenced a response

### Calibration

- weekly experience calibration
- zombie/harmful/core entry evaluation

### Rebuild

- rebuild experience docs using audit log + recent palace fragments

## Implementation Order

1. Add generic subsystem config, inferencer, and storage path helpers
2. Introduce SQLite storage foundation
3. Rebuild palace layer on structured storage
4. Add active layer and maintenance flows
5. Add task-context layer
6. Add builtin retrieval + remote embeddings
7. Add QMD backend
8. Integrate runtime, MCP, adapters, and docs
