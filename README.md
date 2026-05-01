# MarvMem

Layered memory subsystem for AI agents.

MarvMem is extracted from Marv and rebuilt as a standalone package. It is not a single memory table or one compressed summary. It keeps long-term memory, active working state, and task-local context separate, then composes them when an agent needs recall.

MarvMem 是从 Marv 中抽取出来的分层记忆子系统。它不是一张简单的记忆表，也不是单一摘要，而是把长期记忆、当前工作状态和任务上下文分层保存，并在需要时组合召回。

## Why / 为什么

Most agent memory systems drift toward either full chat history or one rolling summary. MarvMem keeps the layers separate:

- Palace: durable records with scope, kind, source, tags, confidence, importance, and metadata
- Active memory: compressed `context` and reusable `experience`
- Task context: task transcript entries, rolling summaries, and decisions
- Retrieval: local weighted scoring, optional embedding rerank, optional QMD backend

这样做的好处是：写入更可控，召回更容易解释，跨 agent 共享记忆时也能保留来源和标记，而不会把所有上下文揉成一团。

## Highlights / 功能摘要

- SQLite by default, with WAL mode and FTS5
- In-memory store for tests and ephemeral sessions
- Scope-aware memory records: `user`, `task`, `agent`, `session`, `document`, `project`, `repo`
- CJK-aware tokenizer for Chinese/Japanese/Korean text
- Local builtin retrieval with no external API requirement
- Optional OpenAI, Gemini, Voyage, or script-based embeddings
- Active memory and task context managers
- Runtime layer for turn capture and prompt-ready recall
- 14 MCP tools plus local stdio MCP server
- Local setup for Codex, Claude Code, Cursor, GitHub Copilot, and Antigravity
- Browser console and terminal TUI for agent setup
- Hermes and OpenClaw compatibility adapters
- Source, tags, metadata, and source history are preserved through writes and recall

## Install / 安装

```bash
npm install
npm run build
```

Requirements:

- Node.js `>= 22.13.0`
- ESM environment

Verify:

```bash
npm run check
npm test
```

## Quick Start / 最小示例

```ts
import { createMarvMem } from "marvmem";
import { createMemoryRuntime } from "marvmem/runtime";

const memory = createMarvMem({
  storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" },
});

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [{ type: "user", id: "alice" }],
});

await runtime.captureTurn({
  taskId: "reply-style",
  taskTitle: "Reply style guidance",
  userMessage: "Remember that I prefer concise Chinese replies.",
});

const recall = await runtime.buildRecallContext({
  taskId: "reply-style",
  userMessage: "How should I answer this user?",
  maxChars: 800,
});

console.log(recall.injectedContext);
```

## MCP / Agent Setup

Run the local MCP server:

```bash
npm run build
node dist/bin/marvmem-mcp.js
```

Install MarvMem globally into supported coding agents:

```bash
node dist/bin/marvmem-agent.js install all
```

This writes agent MCP config, imports existing local sessions, and adds global memory-use instructions where the host supports an instruction file. All supported agents point at the same default SQLite store:

```text
~/.marvmem/memory.sqlite
```

Supported targets:

```text
codex | claude | cursor | copilot | antigravity | all
```

Start the browser setup console:

```bash
node dist/bin/marvmem-agent.js ui
```

Start the terminal setup UI:

```bash
node dist/bin/marvmem-agent.js tui
node dist/bin/marvmem-agent.js tui --once
```

这些入口都会复用同一套 agent manager：探测 MCP 配置、写入全局配置、导入历史 session，并显示每个 agent 已写入的 memory/task 数量。

## Benchmarks / 基准测试

Full methodology and per-category analysis live in [`benchmarks/BENCHMARKS.md`](benchmarks/BENCHMARKS.md).

LongMemEval retrieval recall, 500 questions over about 19k sessions:

| Mode | R@5 | R@10 | NDCG@10 | LLM required |
|------|-----|------|---------|--------------|
| Builtin, zero dependency | 89.6% | 94.6% | 0.834 | No |
| BGE-M3 local rerank | 95.8% | 97.6% | 0.915 | No |
| Gemini rerank | 96.2% | 97.6% | 0.902 | No |

LoCoMo retrieval recall, 1986 QA pairs over 10 conversations:

| Mode | R@5 | R@10 | NDCG@10 | LLM required |
|------|-----|------|---------|--------------|
| Builtin, zero dependency | 84.1% | 92.0% | 0.733 | No |
| BGE-M3 local rerank | 88.3% | 94.8% | 0.789 | No |
| Gemini rerank | 87.6% | 94.2% | 0.775 | No |

README 只保留摘要数字。复现命令、数据集说明和结果解释请看 benchmark 文档。

## Documentation / 文档

| Document | 内容 |
|----------|------|
| [`docs/USAGE.md`](docs/USAGE.md) | Step-by-step integration guide, including MCP, agent setup, UI/TUI, imports, and storage choices |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layer design, module structure, recall flow, turn capture flow, SQLite schema |
| [`docs/API.md`](docs/API.md) | Core APIs, runtime, retrieval, MCP tools, adapters, HTTP routes, package exports |
| [`benchmarks/BENCHMARKS.md`](benchmarks/BENCHMARKS.md) | Benchmark methodology, commands, and full result notes |

## Package Exports / 包入口

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

## Current Boundaries / 当前边界

- Builtin search is local and deterministic. Very large stores should use embedding rerank or QMD.
- Remote embeddings are opt-in. API keys alone do not enable remote calls.
- QMD support requires the `qmd` CLI in `PATH`.
- Turn capture currently uses lightweight proposal extraction unless you provide an inferencer.
- Markdown host compatibility is one-way SQLite to markdown after first import.
- Generic adapters are thin by design. Host-specific wrappers should reuse host provider/model/auth when available.

## License / 许可

Private.

