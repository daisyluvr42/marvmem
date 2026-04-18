# MarvMem 使用说明

这份文档按“怎么接进去、怎么选层、怎么上线”来写，适合第一次把 MarvMem 接进 agent、服务或工具链。

## 1. 先理解它是什么

MarvMem 不是单层记忆表，而是一个分层系统：

- `memory palace`
  全量长期记忆，完整保留
- `active memory`
  面向当前工作的压缩记忆，分成 `context` 和 `experience`
- `task context`
  当前任务的 recent entries、rolling summary、key decisions
- `retrieval`
  builtin recall，可选 remote embeddings，可选 QMD
- `maintenance`
  attribution、calibration、rebuild、deep consolidation

如果你想保留 Marv 那种“全量记忆 + 活跃压缩 + 工作区任务态”的优势，MarvMem 的价值就在这里。

## 2. 运行要求

- Node.js `>= 22.13.0`
- ESM 项目

本地开发：

```bash
npm install
npm run build
```

验证：

```bash
npm run check
npm test
```

## 3. 最小接入方式

如果你先只想跑起来，最小接法就是：

- 一个 `createMarvMem()`
- 一个 `createMemoryRuntime()`

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

这样你已经拥有：

- palace 存取和搜索
- active memory 压缩
- task context 能力
- layered recall runtime

## 4. scope 怎么设计

scope 决定一条记忆属于谁、在哪个上下文生效。

常见建议：

- `user`
  用户长期偏好、身份、约束
- `task`
  某个具体任务或 workflow 的决定
- `agent`
  agent 自己的行为约束
- `session`
  会话内临时记忆
- `document`
  某个文件、文档或知识对象

例子：

```ts
{ type: "user", id: "alice", weight: 1.05 }
{ type: "task", id: "release-2026-04-18", weight: 1 }
```

`weight` 不是必须的，只在检索排序时作为附加因子。

## 5. palace 怎么用

### 写入

```ts
await memory.remember({
  scope: { type: "user", id: "alice" },
  kind: "preference",
  content: "用户偏好简洁的中文回复。",
  importance: 0.9,
  tags: ["language", "style"],
  source: "manual",
});
```

### 搜索

```ts
const hits = await memory.search("怎么回复这个用户", {
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxResults: 5,
});
```

每个命中都会带：

- `record`
- `score`
- `reasons.lexical`
- `reasons.hash`
- `reasons.recency`
- `reasons.importance`
- `reasons.scope`
- `snippet`

### 召回成 prompt 文本

```ts
const recall = await memory.recall({
  query: "怎么回复这个用户",
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxChars: 800,
});
```

这个适合你只想用 palace，不想先接整套 runtime 的场景。

## 6. active memory 怎么用

active memory 分两部分：

- `context`
  当前工作上下文，短期、会覆盖
- `experience`
  可复用经验，低频更新、偏稳定

### distill active context

```ts
await memory.active.distillContext({
  scope: { type: "task", id: "release-2026-04-18" },
  sessionSummary: "我们正在整理发布清单、release notes 和 QA 交接。",
});
```

### distill active experience

```ts
await memory.active.distillExperience({
  scope: { type: "task", id: "release-2026-04-18" },
  newData: "发布清单应该尽量短，只保留可执行项。",
});
```

### 读取 active memory

```ts
const context = await memory.active.read("context", {
  type: "task",
  id: "release-2026-04-18",
});

const experience = await memory.active.read("experience", {
  type: "task",
  id: "release-2026-04-18",
});
```

## 7. task context 怎么用

task context 负责“当前任务正在发生什么”。

### 建任务

```ts
await memory.task.create({
  taskId: "release-flow",
  scope: { type: "task", id: "release-2026-04-18" },
  title: "Release flow",
});
```

### 追加 entry

```ts
await memory.task.appendEntry({
  taskId: "release-flow",
  role: "user",
  content: "我们还差最终 QA checklist。",
});
```

### 记关键决策

```ts
await memory.task.addDecision({
  taskId: "release-flow",
  content: "checklist 保持简短并且可执行。",
});
```

### 生成 task window

```ts
const window = await memory.task.buildWindow({
  taskId: "release-flow",
  currentQuery: "发布前还差什么？",
});
```

这个 window 适合直接拼到 prompt 前面。

## 8. runtime 怎么接

如果你不想自己手动编排 palace、active、task 三层，直接用 runtime。

### 自动捕获 turn

```ts
const capture = await runtime.captureTurn({
  taskId: "release-flow",
  taskTitle: "Release flow",
  userMessage: "Remember that I prefer concise Chinese replies.",
});
```

它会做这些事：

- 从 turn 里推断 durable memory
- 写进 palace
- 写 task entries
- 更新 rolling summary
- 刷 active context

### 生成 layered recall

```ts
const recall = await runtime.buildRecallContext({
  taskId: "release-flow",
  userMessage: "我们之前决定怎么部署来着？",
  recentMessages: ["刚才还在比较 Fly.io 和 Railway。"],
  maxChars: 1000,
});
```

这一步不是单纯 search，而是会组合：

- active context
- active experience
- task window
- palace recall
- 可选 retrieval backend

### 写 reflection

```ts
await runtime.captureReflection({
  taskId: "release-flow",
  summary: "adapter API 要保持框架无关，不绑死某个 agent runtime。",
  scopes: [{ type: "task", id: "release-2026-04-18" }],
});
```

## 9. retrieval 怎么选

### 方案 A：只用 builtin

适合：

- 本地优先
- 简单部署
- 不想依赖外部 provider

这是默认路径。

### 方案 B：builtin + remote embeddings

适合：

- 想保留本地 recall
- 但需要更强的语义 rerank

支持：

- OpenAI
- Gemini
- Voyage

常用环境变量：

- `OPENAI_API_KEY`
- `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`
- `VOYAGE_API_KEY`

示例：

```ts
const memory = createMarvMem({
  storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" },
  retrieval: {
    backend: "builtin",
    embeddings: { provider: "openai" },
  },
});
```

### 方案 C：QMD backend

适合：

- 你已经有 `qmd` CLI
- 你想把外部检索后端接进来

示例：

```ts
const memory = createMarvMem({
  retrieval: {
    backend: "qmd",
    qmd: {
      enabled: true,
      command: "qmd",
      collections: [
        {
          name: "memory",
          path: ".marvmem/qmd",
          pattern: "**/*.md",
        },
      ],
      includeDefaultMemory: true,
    },
  },
});
```

## 10. maintenance 怎么接

这一层是 MarvMem 很重要的特点之一，不只是“存完就不管”。

### attribution

判断 agent 的回答激活了哪些 experience 条目：

```ts
await memory.maintenance.attributeExperience({
  scope: { type: "task", id: "release-2026-04-18" },
  response: "我会把 checklist 保持简短并且可执行。",
  outcome: "positive",
});
```

### calibration

清理 stale / harmful / weak experience：

```ts
await memory.maintenance.calibrateExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});
```

### rebuild

用 recent palace fragments 重建 experience：

```ts
await memory.maintenance.rebuildExperience({
  scope: { type: "task", id: "release-2026-04-18" },
});
```

## 11. MCP 怎么接

如果你要暴露给外部 agent 或 MCP client，用：

```ts
import { createMemoryMcpHandler } from "marvmem/mcp";

const handler = createMemoryMcpHandler({ memory });
```

当前工具包括：

- `memory_search`
- `memory_get`
- `memory_list`
- `memory_write`
- `memory_update`
- `memory_delete`
- `memory_recall`
- `memory_retrieve`
- `memory_active_get`
- `memory_active_distill`
- `memory_task_append`
- `memory_task_window`
- `memory_maintenance_calibrate`
- `memory_maintenance_rebuild`

如果你要的是：

- “给我 prompt-ready recall”
  用 `memory_recall`
- “走完整 retrieval stack”
  用 `memory_retrieve`
- “操作 active memory”
  用 `memory_active_*`
- “操作 task context”
  用 `memory_task_*`

## 12. 存储怎么选

### 默认：SQLite

推荐给正式使用：

```ts
storage: { backend: "sqlite", path: ".marvmem/memory.sqlite" }
```

### InMemoryStore

适合：

- 单元测试
- 临时 session
- demo

```ts
import { createMarvMem, InMemoryStore } from "marvmem";

const memory = createMarvMem({
  store: new InMemoryStore(),
});
```

## 13. 怎么选推荐接法

如果你只要一个可用的分层记忆系统，我建议：

- 单进程应用
  `createMarvMem()` + `createMemoryRuntime()`
- 需要对外暴露工具
  再加 `createMemoryMcpHandler()`
- 已经有固定 agent 框架
  直接包 adapter

如果你只想先试 palace：

- 只用 `memory.remember/search/recall`

如果你想保留这个系统最有特点的地方：

- 一定要把 `active memory + task context + maintenance` 一起接进去

## 14. 当前边界

- palace 这一层对外还是简单的 `MemoryStore` 读写接口，不是完整 SQL CRUD API
- builtin retrieval 仍然从本地确定性分数出发，remote embeddings 是可选 rerank
- 开启 QMD backend 时，运行环境里需要已有 `qmd` CLI
- runtime 抽取规则是轻量启发式
- adapter 层刻意保持很薄，不做重封装
