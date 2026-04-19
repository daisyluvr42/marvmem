# MarvMem 接入指南

这份文档面向第一次把 MarvMem 接进自己项目的开发者。内容按照接入顺序组织，从最小可用配置开始，逐步介绍各个子系统的用法。

## 1. MarvMem 是什么

MarvMem 是一个分层的记忆子系统，和常见的"一张表存所有记忆"或者"一个压缩摘要"的方案不同。它同时维护三个层次的记忆：

- **Palace（长期记忆）**：每条记忆都完整保留，带有 scope、kind、confidence、importance、tags 等元数据。
- **Active Memory（活跃记忆）**：把 palace 中的内容压缩成两份文档——`context` 负责追踪当前工作状态，`experience` 负责沉淀可复用的经验。
- **Task Context（任务上下文）**：在单个任务粒度上管理对话 entries、rolling summary 和 key decisions。

在这三层之上还有三个横切模块：retrieval 负责检索编排，maintenance 负责经验维护（attribution、calibration、rebuild），runtime 负责把这些拼成一个完整的生命周期。

## 2. 运行要求

MarvMem 使用了 Node.js 内置的 `node:sqlite` 模块，所以需要 Node.js 22.13.0 或更高版本，并且项目需要是 ESM 模式。

```bash
npm install
npm run build
npm run check  # TypeScript 类型检查
npm test       # 运行测试
```

## 3. 最小可用配置

最简单的接入方式只需要创建两个对象：

```ts
import { createMarvMem } from "marvmem";
import { createMemoryRuntime } from "marvmem/runtime";

const memory = createMarvMem({
  storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" },
  inferencer: async ({ kind, prompt }) => ({
    ok: true,
    text: `${kind}: ${prompt.slice(0, 200)}`,
  }),
});

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [{ type: "user", id: "alice", weight: 1.05 }],
});
```

这样就已经可以使用 palace 的存取和搜索、active memory 的压缩、task context 的管理以及 layered recall 了。

上面的 `inferencer` 是一个 stub 实现。distillation、calibration、rebuild 这些操作都会通过这个接口调用 LLM，正式使用时需要把它替换成你自己的模型调用逻辑。没有配置 inferencer 的情况下，这些操作会 fallback 到简单的文本截断拼接，不会报错。

## 4. Scope 的设计

每条记忆都需要一个 scope，用来标记这条记忆属于谁、在什么上下文下生效。

| type | 用途 |
|------|------|
| `user` | 用户级的长期偏好和身份信息 |
| `task` | 某个具体任务或 workflow 中的决定 |
| `agent` | agent 自身的行为规则和约束 |
| `session` | 单次会话内的临时记忆 |
| `document` | 绑定到某个文件或文档的记忆 |

scope 的 `weight` 字段是可选的，只在检索排序时作为加权因子使用：

```ts
{ type: "user", id: "alice", weight: 1.05 }
{ type: "task", id: "release-2026-04-18" }
```

## 5. Palace 的使用

### 写入记忆

```ts
await memory.remember({
  scope: { type: "user", id: "alice" },
  kind: "preference",
  content: "用户偏好简洁的中文回复。",
  importance: 0.9,
  tags: ["language", "style"],
});
```

写入时 MarvMem 会自动和已有的同 scope、同 kind 记录做相似度比对。如果相似度超过阈值（默认 0.85），新内容会合并到已有记录上，而不是创建一条新的。

### 搜索

```ts
const hits = await memory.search("怎么回复这个用户", {
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxResults: 5,
});
```

每个命中结果都包含 `score` 总分和 `reasons` 分项（lexical、hash、recency、importance、scope 五个维度），以及一段 `snippet` 摘要。

### 召回为 prompt 文本

```ts
const recall = await memory.recall({
  query: "怎么回复这个用户",
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxChars: 800,
});
// recall.injectedContext 可以直接拼进 system prompt
```

如果你只想用 palace 这一层，不需要接 runtime，用到这里就够了。

## 6. Active Memory 的使用

Active memory 分成两部分：`context` 是当前工作状态的快照，每次 distill 都会覆盖上一次的内容；`experience` 是可复用的经验总结，更新频率较低。

```ts
// 压缩当前上下文
await memory.active.distillContext({
  scope: { type: "task", id: "release-2026-04-18" },
  sessionSummary: "我们在整理发布清单和 QA 交接。",
});

// 积累经验
await memory.active.distillExperience({
  scope: { type: "task", id: "release-2026-04-18" },
  newData: "发布清单只保留可执行项，不要放说明文字。",
});

// 读取
const ctx = await memory.active.read("context", { type: "task", id: "release-2026-04-18" });
const exp = await memory.active.read("experience", { type: "task", id: "release-2026-04-18" });
```

## 7. Task Context 的使用

Task context 管理的是单个任务维度的信息：谁说了什么、当前的总结是什么、做过哪些关键决策。

```ts
// 创建任务
await memory.task.create({
  taskId: "release-flow",
  scope: { type: "task", id: "release-2026-04-18" },
  title: "Release flow",
});

// 追加对话 entry
await memory.task.appendEntry({
  taskId: "release-flow",
  role: "user",
  content: "还差最终 QA checklist。",
});

// 记录关键决策
await memory.task.addDecision({
  taskId: "release-flow",
  content: "checklist 保持简短、可执行。",
});

// 生成 prompt 窗口
const window = await memory.task.buildWindow({
  taskId: "release-flow",
  currentQuery: "发布前还差什么？",
});
```

`buildWindow` 返回的 `injectedContext` 包含 rolling summary、key decisions 和 recent entries，可以直接拼进 prompt。`charUsage` 字段会告诉你每个部分各占了多少字符。

## 8. Runtime 的使用

如果你不想手动编排 palace、active memory 和 task context 三层的调用顺序，可以直接使用 runtime。

### 捕获一轮对话

```ts
const capture = await runtime.captureTurn({
  taskId: "release-flow",
  taskTitle: "Release flow",
  userMessage: "记住我喜欢简洁的中文回复。",
  assistantMessage: "好的，以后用简洁中文。",
});
```

这一次调用会完成以下所有步骤：从用户消息里启发式提取可持久化的记忆（显式 remember 请求、偏好、决策、身份信息），写入 palace，追加 task entries 并更新 rolling summary，最后刷新 active context。

### 构建分层召回

```ts
const recall = await runtime.buildRecallContext({
  taskId: "release-flow",
  userMessage: "我们之前决定怎么部署来着？",
  recentMessages: ["刚才在比较 Fly.io 和 Railway。"],
  maxChars: 1000,
});
```

这一步会按 active memory → task window → palace recall → retrieval 的顺序合并四个层次的记忆，最终结果在 `recall.injectedContext` 中。如果需要分层检查，各层的原始内容在 `recall.layers` 里。

### 写入 reflection

```ts
await runtime.captureReflection({
  taskId: "release-flow",
  summary: "adapter API 要保持框架无关。",
  scopes: [{ type: "task", id: "release-2026-04-18" }],
});
```

这个操作会同时写 palace experience 记录、distill active experience、并在 task context 中追加一条 decision。

## 9. Adapter 的使用

如果你已经有自己的 agent loop，可以用 adapter 来简化集成。

### 逐轮 wrapper

每轮对话自动完成 capture 和 recall：

```ts
import { createGenericMemoryAdapter } from "marvmem/adapters";

const adapter = createGenericMemoryAdapter({
  memory,
  defaultScopes: [{ type: "agent", id: "support-bot" }],
});

// 在生成回复之前调用，获取记忆上下文
const { systemHint, injectedContext } = await adapter.beforePrompt({
  userMessage: "下一步做什么？",
});

// 在回复生成之后调用，持久化本轮的记忆
await adapter.afterTurn({
  userMessage: "记住我偏好简洁中文回复。",
  assistantMessage: "收到。",
});
```

### Session-flush wrapper

对于 Codex、Claude Code 这类 tool-heavy 的 agent，每轮都做 active context 和 task summary 的压缩可能开销太大。session-flush wrapper 把这些重操作延后到 session 结束时统一执行，但 recall 每轮仍然可用：

```ts
import { createSessionMemoryAdapter } from "marvmem/adapters";

const adapter = createSessionMemoryAdapter({
  memory,
  defaultScopes: [{ type: "session", id: "codex-run-001" }],
});

await adapter.beforePrompt({ userMessage: "下一步？", taskId: "release" });
await adapter.afterTurn({
  userMessage: "还差 release checklist。",
  assistantMessage: "好的，保持简短。",
  taskId: "release",
  taskTitle: "Release checklist",
});

// 在 session 结束时调用
await adapter.flushSession();
```

### 怎么选

| 使用场景 | 推荐方案 |
|---------|---------|
| 全自动、每轮完整 capture | `createGenericMemoryAdapter` |
| 想控制 token 开销，宿主能确定 session 结束时机 | `createSessionMemoryAdapter` |
| 已经有一份 Hermes，想少配一点直接接进去 | `marvmem-hermes install-plugin` |
| 需要暴露给外部 client 或多 agent 工具调用 | MCP handler |

### 接入 Hermes

如果你要把 Hermes 自带的 `MEMORY.md` / `USER.md` 交给 MarvMem 管理，推荐直接用 `installHermesAgentMemoryTakeover()`。它会做几件事：

- 默认按 session-flush 的方式工作
- 安装时先把已有的 `md` 内容导入进来
- 之后由 MarvMem 统一管理这些记忆
- 每次记忆有变化时，再把结果写回原来的文件

```ts
import { createMarvMem } from "marvmem";
import { installHermesAgentMemoryTakeover } from "marvmem/adapters";

const memory = createMarvMem({
  storage: { backend: "sqlite", path: "~/.marvmem/memory.sqlite" },
  inferencer: async ({ kind, prompt }) => ({ ok: true, text: `${kind}: ${prompt}` }),
});

const { adapter, imported } = await installHermesAgentMemoryTakeover({
  memory,
  defaultScopes: [{ type: "agent", id: "hermes" }],
});

console.log(imported);

await adapter.afterTurn({
  userMessage: "Remember that I prefer concise Chinese replies.",
  assistantMessage: "I will keep responses concise.",
});
```

默认文件位置：

- `~/.hermes/memories/MEMORY.md`
- `~/.hermes/memories/USER.md`

如果你已经有一份 Hermes，想直接接到现成实例里，不改 Hermes 源码也可以。先 build，再安装 bridge plugin：

```bash
npm run build
node dist/bin/marvmem-hermes.js install-plugin \
  --hermes-home ~/.hermes \
  --storage-path ~/.hermes/marvmem.sqlite \
  --scope-type agent \
  --scope-id hermes
```

这个命令会先做一次初始化导入，然后把一个 Hermes plugin 写到 `~/.hermes/plugins/marvmem/`。后面 Hermes 每轮结束、原生 `memory` 工具写入、以及 session 结束时，都会自动把变更同步回 MarvMem，再把 `MEMORY.md` / `USER.md` 刷新出来。

### 接入 OpenClaw

如果你要把 OpenClaw 的 markdown memory 交给 MarvMem 管理，同样直接用 `installOpenClawMemoryTakeover()`。当前实现会处理：

- `MEMORY.md`
- `USER.md`
- `memory/YYYY-MM-DD.md`
- `DREAMS.md`

```ts
import { createMarvMem } from "marvmem";
import { installOpenClawMemoryTakeover } from "marvmem/adapters";

const memory = createMarvMem({
  storage: { backend: "sqlite", path: "~/.marvmem/memory.sqlite" },
  inferencer: async ({ kind, prompt }) => ({ ok: true, text: `${kind}: ${prompt}` }),
});

const { adapter } = await installOpenClawMemoryTakeover({
  memory,
  defaultScopes: [{ type: "agent", id: "openclaw" }],
});

await adapter.afterTurn({
  taskTitle: "Release checklist",
  userMessage: "Remember that we use pnpm workspaces.",
  assistantMessage: "I will keep using pnpm workspaces.",
});

await adapter.flushSession();
```

默认工作区位置：

- `~/.openclaw/workspace/MEMORY.md`
- `~/.openclaw/workspace/USER.md`
- `~/.openclaw/workspace/memory/YYYY-MM-DD.md`
- `~/.openclaw/workspace/DREAMS.md`

如果你已经有一份真实的 OpenClaw 安装，想尽量少配东西，直接装 bridge plugin 就行：

```bash
npm run build
node dist/bin/marvmem-openclaw.js install-plugin \
  --scope-type agent \
  --scope-id openclaw
```

这个命令会先做一次初始化导入，然后把一个 OpenClaw plugin 写到 `~/.openclaw/plugins/marvmem/`。后面 OpenClaw 每轮开始前会先取 MarvMem 的 recall，上下文注入到 prompt 里；每轮结束后，再把这一轮对话写回 MarvMem，并刷新 `MEMORY.md` / `USER.md` / `DREAMS.md` 和当天的 `memory/YYYY-MM-DD.md`。

如果当前 OpenClaw 会话本身已经配好了正常的 HTTP 模型 provider，这个 bridge 还会直接复用那一套 provider/model 来做 MarvMem 的 session summary。也就是说，OpenClaw 这条接法默认不需要再额外给 MarvMem 配一套总结模型。

## 10. Retrieval 的配置

### 只用 builtin（默认）

默认配置下 MarvMem 使用本地五维加权评分做检索，不需要任何外部服务。

### 加上 remote embeddings

如果你需要更强的语义 rerank 能力，可以显式配置 remote embedding provider。仅仅在环境变量里设置了 API key 并不会自动开启这个功能。

```ts
const memory = createMarvMem({
  retrieval: {
    backend: "builtin",
    embeddings: { provider: "openai" },  // 也可以用 "gemini"、"voyage" 或 "auto"
  },
});
```

相关的环境变量：`OPENAI_API_KEY`、`GEMINI_API_KEY`（或 `GOOGLE_API_KEY`）、`VOYAGE_API_KEY`。

### QMD backend

如果你的环境中已经安装了 `qmd` CLI，可以把它作为外部检索后端接入：

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

## 11. Maintenance 的使用

MarvMem 的 experience 不是写完就不管的，maintenance 模块提供了四个维护操作：

```ts
// attribution：判断这次回答中哪些 experience 条目实际起了作用
await memory.maintenance.attributeExperience({
  scope: { type: "task", id: "release-2026-04-18" },
  response: "checklist 保持简短。",
  outcome: "positive",
});

// calibration：检测并清理 zombie 条目（从未激活且在近期记忆中找不到支撑的）、harmful 条目（激活多次但正面反馈比例低的）
await memory.maintenance.calibrateExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});

// rebuild：从 palace 中最近的记录重新构建 experience 文档
await memory.maintenance.rebuildExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});

// deep consolidation：依次执行 rebuild 和 calibrate
await memory.maintenance.deepConsolidate({
  scope: { type: "task", id: "release-2026-04-18" },
});
```

## 12. MCP 的接入

有两种接法：

- 自己写宿主：直接用 `createMemoryMcpHandler()`
- 给 Codex、Claude Code、Cursor、Copilot 这类 MCP client 用：运行本地 `marvmem-mcp` stdio server

如果你需要把 MarvMem 嵌进自己的宿主，可以直接使用 MCP handler：

```ts
import { createMemoryMcpHandler } from "marvmem/mcp";
const handler = createMemoryMcpHandler({ memory });
```

MCP handler 提供了 14 个工具：

| 工具 | 功能 |
|------|------|
| `memory_search` | 按 query 搜索 palace 记录 |
| `memory_get` | 按 id 获取单条记录 |
| `memory_list` | 列出记录，可按 scope 过滤 |
| `memory_write` | 写入一条记录（自动去重） |
| `memory_update` | 修改已有记录 |
| `memory_delete` | 删除记录 |
| `memory_recall` | 生成 prompt-ready 的召回文本 |
| `memory_retrieve` | 执行完整的 retrieval stack |
| `memory_active_get` | 读取 active context 和 experience |
| `memory_active_distill` | 压缩 active memory |
| `memory_task_append` | 追加 task entry（如果 task 不存在会自动创建） |
| `memory_task_window` | 生成 task prompt 窗口 |
| `memory_maintenance_calibrate` | 执行 experience 校准 |
| `memory_maintenance_rebuild` | 重建 experience |

如果你是要本地部署一个正式可用的 MCP server，推荐直接运行：

```bash
npm run build
node dist/bin/marvmem-mcp.js
```

默认行为：

- 存储路径：`~/.marvmem/memory.sqlite`
- retrieval backend：`builtin`
- remote embeddings：默认关闭，只有显式配置才启用

常用环境变量：

```bash
MARVMEM_STORAGE_PATH=/custom/path/memory.sqlite
MARVMEM_SCOPE_TYPE=agent
MARVMEM_SCOPE_ID=codex
MARVMEM_RETRIEVAL_BACKEND=builtin
MARVMEM_EMBEDDINGS_PROVIDER=openai
MARVMEM_EMBEDDINGS_MODEL=text-embedding-3-small
```

接到 Codex 的方式：

```bash
codex mcp add marvmem \
  --env MARVMEM_SCOPE_TYPE=agent \
  --env MARVMEM_SCOPE_ID=codex \
  -- node /absolute/path/to/marvmem/dist/bin/marvmem-mcp.js
```

如果当前 Codex 会话没有立刻看到新 server，开一个新会话再试。

接到 Claude Code 的方式：

```bash
claude mcp add-json -s project marvmem '{"type":"stdio","command":"node","args":["/absolute/path/to/marvmem/dist/bin/marvmem-mcp.js"],"env":{"MARVMEM_SCOPE_TYPE":"agent","MARVMEM_SCOPE_ID":"claude"}}'
```

这条命令会在当前项目写入 `.mcp.json`。可以用 `claude mcp get marvmem` 确认 server 已连接。

## 13. 存储方式的选择

SQLite 是默认的存储后端，正式使用时推荐这个：

```ts
storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" }
```

跑测试或者做 demo 的时候可以用 InMemoryStore，数据只在内存中存在：

```ts
import { createMarvMem, InMemoryStore } from "marvmem";
const memory = createMarvMem({ store: new InMemoryStore() });
```

## 14. 接入方式总结

| 你的情况 | 推荐接法 |
|---------|---------|
| 单进程应用，先跑起来 | `createMarvMem()` + `createMemoryRuntime()` |
| 需要把记忆工具暴露给外部 | 优先用 `marvmem-mcp`，自定义宿主再直接用 `createMemoryMcpHandler()` |
| 有现成的 agent 框架，宿主可以控制 session 结束 | 用 `createSessionMemoryAdapter()` |
| 有现成的 agent 框架，想全自动处理 | 用 `createGenericMemoryAdapter()` |
| 只想评估 palace 这一层 | 只用 `memory.remember` / `search` / `recall` |

这个系统最有特点的地方在于 active memory、task context 和 maintenance 三层协同工作。只接 palace 当然能用，但 MarvMem 相比普通记忆表的差异化价值主要来自这三层。

## 15. 当前的限制

- Palace 对外暴露的是 `MemoryStore` 接口（`load()` / `save()`），不是直接的 SQL 查询 API。
- Builtin retrieval 基于确定性的本地评分，remote embeddings 是可选的 rerank 层。
- 使用 QMD backend 需要运行环境中已安装 `qmd` CLI。
- Turn capture 中的记忆提取使用的是启发式正则匹配，不是 LLM 调用。
- Session-flush wrapper 的 buffer 存在 adapter 进程内存中，由宿主决定何时 flush。
- Adapter 层设计上刻意保持轻薄，不封装框架特定的逻辑。
