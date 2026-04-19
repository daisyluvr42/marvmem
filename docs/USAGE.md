# MarvMem 接入指南

按"怎么接、怎么选、怎么跑"写。第一次接的直接按顺序看。

## 1. 它是什么

三层记忆，不是一张表：

- **palace** — 全量长期记忆，每条带 scope、kind、confidence、importance、tags
- **active memory** — 压缩层，分 `context`（当前状态）和 `experience`（可复用经验）
- **task context** — 任务粒度的 entries、rolling summary、key decisions

再加 retrieval（检索）、maintenance（维护）、runtime（生命周期编排）三个横切层。

## 2. 运行要求

- Node.js ≥ 22.13.0（用了 `node:sqlite`）
- ESM

```bash
npm install
npm run build
npm run check  # 类型检查
npm test       # 跑测试
```

## 3. 最小接法

两行就能跑：

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

这就有了 palace 存取搜索、active memory 压缩、task context、layered recall。

`inferencer` 是 distillation / calibration / rebuild 用的 LLM 调用封装。上面给的是 stub，接真模型时替换成你自己的实现。

## 4. scope 设计

scope = 这条记忆属于谁。

| type | 典型用途 |
|------|---------|
| `user` | 用户偏好、身份 |
| `task` | 某个任务/workflow 的决定 |
| `agent` | agent 自己的行为规则 |
| `session` | 会话级临时记忆 |
| `document` | 绑定某个文件或文档 |

```ts
{ type: "user", id: "alice", weight: 1.05 }
{ type: "task", id: "release-2026-04-18" }
```

`weight` 可选，只影响检索排序。

## 5. palace

### 写

```ts
await memory.remember({
  scope: { type: "user", id: "alice" },
  kind: "preference",
  content: "用户偏好简洁的中文回复。",
  importance: 0.9,
  tags: ["language", "style"],
});
```

写入时会自动跟已有记录做相似度比对（默认阈值 0.85），撞上了就合并而不是新建。

### 搜

```ts
const hits = await memory.search("怎么回复这个用户", {
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxResults: 5,
});
```

每个 hit 带 `score` 和 `reasons`（lexical / hash / recency / importance / scope 五维分数），还有 `snippet`。

### 召回成 prompt 文本

```ts
const recall = await memory.recall({
  query: "怎么回复这个用户",
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxChars: 800,
});
// recall.injectedContext 可以直接拼进 system prompt
```

只想用 palace 不接 runtime 的话，到这里就够了。

## 6. active memory

分两块：

- `context` — 当前工作的上下文快照，短命，每次覆盖
- `experience` — 可复用的经验总结，慢更新

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

// 读
const ctx = await memory.active.read("context", { type: "task", id: "release-2026-04-18" });
const exp = await memory.active.read("experience", { type: "task", id: "release-2026-04-18" });
```

distill 会调 inferencer；没配 inferencer 就直接截断拼接，不会报错。

## 7. task context

管"这个任务里发生了什么"。

```ts
// 建任务
await memory.task.create({
  taskId: "release-flow",
  scope: { type: "task", id: "release-2026-04-18" },
  title: "Release flow",
});

// 追加 entry
await memory.task.appendEntry({
  taskId: "release-flow",
  role: "user",
  content: "还差最终 QA checklist。",
});

// 记决策
await memory.task.addDecision({
  taskId: "release-flow",
  content: "checklist 保持简短、可执行。",
});

// 拼成 prompt 窗口
const window = await memory.task.buildWindow({
  taskId: "release-flow",
  currentQuery: "发布前还差什么？",
});
// window.injectedContext = rolling summary + key decisions + recent entries
// window.charUsage 告诉你每个部分占了多少字符
```

## 8. runtime

不想手动编排三层的话，直接用 runtime。

### 捕获 turn

```ts
const capture = await runtime.captureTurn({
  taskId: "release-flow",
  taskTitle: "Release flow",
  userMessage: "记住我喜欢简洁的中文回复。",
  assistantMessage: "好的，以后用简洁中文。",
});
```

一次调用做完这些事：

1. 从用户消息里启发式提取 durable memory（显式 remember、偏好、决策、身份）
2. 写进 palace
3. 追加 task entries + 更新 rolling summary
4. 刷 active context

### layered recall

```ts
const recall = await runtime.buildRecallContext({
  taskId: "release-flow",
  userMessage: "我们之前决定怎么部署来着？",
  recentMessages: ["刚才在比较 Fly.io 和 Railway。"],
  maxChars: 1000,
});
```

按 active → task window → palace → retrieval 四层合并，结果在 `recall.injectedContext`。各层的原始内容在 `recall.layers`。

### 写 reflection

```ts
await runtime.captureReflection({
  taskId: "release-flow",
  summary: "adapter API 要保持框架无关。",
  scopes: [{ type: "task", id: "release-2026-04-18" }],
});
```

写 palace experience 记录 + distill active experience + 追加 task decision。

## 9. adapter

已经有 agent loop 的话，接 adapter 省事。

### 逐轮 wrapper

每轮自动 capture + recall：

```ts
import { createGenericMemoryAdapter } from "marvmem/adapters";

const adapter = createGenericMemoryAdapter({
  memory,
  defaultScopes: [{ type: "agent", id: "support-bot" }],
});

// 生成回复前
const { systemHint, injectedContext } = await adapter.beforePrompt({
  userMessage: "下一步做什么？",
});

// 生成回复后
await adapter.afterTurn({
  userMessage: "记住我偏好简洁中文回复。",
  assistantMessage: "收到。",
});
```

### session-flush wrapper

适合 Codex / Claude Code 这类 tool-heavy agent——recall 每轮可用，但 active context / task summary 延后到 session 结束再压缩：

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

// session 结束时统一 flush
await adapter.flushSession();
```

### 怎么选

| 场景 | 用 |
|------|----|
| 全自动、省心 | `createGenericMemoryAdapter` |
| 想控 token 开销、宿主知道 session 结束时机 | `createSessionMemoryAdapter` |
| 多 agent 工具调用 / 外部 client | MCP handler |

## 10. retrieval

### 只用 builtin（默认）

本地五维加权评分，零外部依赖。

### builtin + remote embeddings

想要更强的语义 rerank 时用。需要显式配置，不会因为有环境变量就自动开启。

```ts
const memory = createMarvMem({
  retrieval: {
    backend: "builtin",
    embeddings: { provider: "openai" },  // 或 "gemini"、"voyage"、"auto"
  },
});
```

环境变量：`OPENAI_API_KEY`、`GEMINI_API_KEY` / `GOOGLE_API_KEY`、`VOYAGE_API_KEY`。

### QMD backend

有 `qmd` CLI 时可以把它当外部检索后端：

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

## 11. maintenance

不只是存完就不管。

```ts
// attribution —— 判断哪些 experience 条目影响了这次回答
await memory.maintenance.attributeExperience({
  scope: { type: "task", id: "release-2026-04-18" },
  response: "checklist 保持简短。",
  outcome: "positive",
});

// calibration —— 清理 zombie / harmful / weak experience
await memory.maintenance.calibrateExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});

// rebuild —— 从 palace 最近的记录重构 experience
await memory.maintenance.rebuildExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});

// deep consolidation —— rebuild + calibrate 一起跑
await memory.maintenance.deepConsolidate({
  scope: { type: "task", id: "release-2026-04-18" },
});
```

## 12. MCP

暴露给外部 agent / MCP client：

```ts
import { createMemoryMcpHandler } from "marvmem/mcp";
const handler = createMemoryMcpHandler({ memory });
```

14 个工具：

| 工具 | 一句话 |
|------|-------|
| `memory_search` | 按 query 搜 palace |
| `memory_get` | 按 id 取一条 |
| `memory_list` | 列记录 |
| `memory_write` | 写记录（自动去重） |
| `memory_update` | 改记录 |
| `memory_delete` | 删记录 |
| `memory_recall` | 生成 prompt-ready 召回文本 |
| `memory_retrieve` | 跑完整 retrieval stack |
| `memory_active_get` | 读 active context / experience |
| `memory_active_distill` | 压缩 active memory |
| `memory_task_append` | 追加 task entry（自动建 task） |
| `memory_task_window` | 生成 task prompt 窗口 |
| `memory_maintenance_calibrate` | 跑 experience 校准 |
| `memory_maintenance_rebuild` | 重建 experience |

## 13. 存储

SQLite 是默认的，正式场景用这个：

```ts
storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" }
```

测试 / demo 用 InMemoryStore：

```ts
import { createMarvMem, InMemoryStore } from "marvmem";
const memory = createMarvMem({ store: new InMemoryStore() });
```

## 14. 推荐接法

| 你的情况 | 接法 |
|---------|------|
| 单进程，先跑起来 | `createMarvMem()` + `createMemoryRuntime()` |
| 要对外暴露工具 | 再加 `createMemoryMcpHandler()` |
| 有 agent 框架，宿主能控 session 生命周期 | `createSessionMemoryAdapter()` |
| 有 agent 框架，想全自动 | `createGenericMemoryAdapter()` |
| 只想试 palace | 只用 `memory.remember` / `search` / `recall` |

最有特点的地方是 active memory + task context + maintenance 这三层一起工作。只接 palace 能用，但差的就是这部分。

## 15. 当前边界

- palace 对外是 `MemoryStore` 的 `load()` / `save()` 接口，不是 SQL query API
- builtin retrieval 从确定性本地分数出发，remote embeddings 是可选 rerank
- QMD 需要运行环境里有 `qmd` CLI
- turn capture 的记忆提取是启发式正则，不是 LLM call
- session-flush wrapper 的 buffer 在 adapter 进程内，宿主决定什么时候 flush
- adapter 层刻意保持薄，不封装框架逻辑
