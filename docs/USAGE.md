# MarvMem 使用说明

这份文档按“怎么接进去”来写，适合第一次把 MarvMem 接到 agent、工具链或服务里。

## 1. 安装与准备

要求：

- Node.js `>= 20`
- ESM 项目

本地开发：

```bash
npm install
npm run build
```

如果你只是想在仓库内验证当前实现：

```bash
npm run check
npm test
```

## 2. 最小接入方式

如果你只需要“写记忆 + 搜记忆 + 拼 prompt”，最简单的接法就是 `createMarvMem()` 加 `createMemoryRuntime()`。

```ts
import { createMarvMem } from "marvmem";
import { createMemoryRuntime } from "marvmem/runtime";

const memory = createMarvMem({
  storagePath: ".marvmem/memory.json",
});

const runtime = createMemoryRuntime({
  memory,
  defaultScopes: [{ type: "user", id: "alice", weight: 1.05 }],
});
```

这样就有两层能力：

- `memory` 负责底层存取、搜索、召回
- `runtime` 负责把 user turn 转成更高层的记忆流程

## 3. 什么时候用什么 scope

scope 决定一条记忆属于谁、在什么上下文里生效。

常见用法：

- `user`：用户长期偏好、身份信息
- `session`：当前会话临时记忆
- `task`：某个任务或工作流的决定
- `agent`：某个 agent 自己的偏好或约束
- `document`：某个文档、文件、知识对象的记忆

例子：

```ts
{ type: "user", id: "alice", weight: 1.05 }
{ type: "task", id: "release-2026-04-18", weight: 1 }
```

`weight` 不是必须的。它只在搜索排序时作为 scope 相关性的一个附加因子。

## 4. 直接写入和读取记忆

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

说明：

- `kind` 可以用内置值，也可以用你自己的字符串
- `content` 是主文本
- `summary` 不传时会自动从 `content` 生成
- `importance` 和 `confidence` 都是 `0-1`

### 搜索

```ts
const hits = await memory.search("怎么回复这个用户", {
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  maxResults: 5,
});
```

返回结果里有：

- `record`
- `score`
- `reasons.lexical`
- `reasons.hash`
- `reasons.recency`
- `reasons.importance`
- `reasons.scope`
- `snippet`

适合拿来做 debug，判断为什么这条记忆被搜出来。

### 召回成 prompt 文本

```ts
const recall = await memory.recall({
  query: "怎么回复这个用户",
  scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  recentMessages: ["刚才在聊回复风格。"],
  maxChars: 800,
});

console.log(recall.injectedContext);
```

`injectedContext` 可以直接拼到 system prompt 或前置上下文里。

## 5. 用 runtime 自动捕获记忆

如果你不想每次都手写 `memory.remember()`，可以让 runtime 从 turn 里自动提取。

```ts
const capture = await runtime.captureTurn({
  userMessage: "Remember that I prefer concise Chinese replies.",
});

console.log(capture.proposals);
console.log(capture.stored);
```

当前默认会识别这些类型：

- 明确的 remember 请求
- preference
- decision
- identity

这是启发式逻辑，故意做得很轻，不是复杂的 NLP 抽取器。

## 6. 在生成回答前召回上下文

典型流程：

1. 收到用户消息
2. 用 `runtime.buildRecallContext()` 召回长期记忆
3. 把 `recall.injectedContext` 拼进 prompt
4. 模型回答后，用 `runtime.captureTurn()` 视情况存新记忆

代码示例：

```ts
const recall = await runtime.buildRecallContext({
  userMessage: "我们之前决定怎么部署来着？",
  recentMessages: ["刚才还在比较 Fly.io 和 Railway。"],
  maxChars: 600,
});

const systemPrompt = [
  "You are a helpful assistant.",
  recall.injectedContext,
].filter(Boolean).join("\n\n");
```

## 7. MCP 接入方式

如果你要把 MarvMem 暴露成 MCP 工具，使用 `createMemoryMcpHandler()`。

```ts
import { createMemoryMcpHandler } from "marvmem/mcp";

const handler = createMemoryMcpHandler({ memory });
```

它支持这些工具：

- `memory_search`
- `memory_get`
- `memory_list`
- `memory_write`
- `memory_update`
- `memory_delete`
- `memory_recall`

### `memory_write`

```json
{
  "name": "memory_write",
  "arguments": {
    "content": "User prefers concise Chinese replies.",
    "kind": "preference",
    "scopeType": "user",
    "scopeId": "alice",
    "importance": 0.9
  }
}
```

### `memory_recall`

```json
{
  "name": "memory_recall",
  "arguments": {
    "message": "How should I answer this user?",
    "scopeType": "user",
    "scopeId": "alice",
    "maxChars": 800
  }
}
```

注意：

- `maxChars` 现在会真正生效
- `scopeType + scopeId` 不传时，会回退到 handler 初始化时的 `defaultScopes`

## 8. Adapter 接入方式

如果你的 agent 框架只需要：

- 回答前拿记忆
- 回答后写记忆
- 暴露 memory 工具

那可以直接用 adapter。

### 通用返回形状

三个 adapter 都提供：

- `tools`
- `beforePrompt()`
- `afterTurn()`

### 例子

```ts
import { createHermesAgentMemoryAdapter } from "marvmem/adapters/hermes-agent";

const adapter = createHermesAgentMemoryAdapter({
  memory,
  defaultScopes: [{ type: "agent", id: "hermes", weight: 1 }],
});

const promptMemory = await adapter.beforePrompt({
  userMessage: "What did we decide about deployment?",
});

await adapter.afterTurn({
  userMessage: "Remember that we should keep the API easy to integrate.",
});
```

## 9. 去重、排序和长度控制

### 去重

`remember()` 默认会对近似重复内容做合并，而不是无脑新增。

```ts
const memory = createMarvMem({
  storagePath: ".marvmem/memory.json",
  dedupeThreshold: 0.85,
});
```

如果你不想自动合并，可以把它设成 `1`。

### 搜索排序

搜索分数综合这些因素：

- 词项重叠
- 本地 hash 相似度
- 新近程度
- 重要性
- scope 权重

如需调参：

```ts
const memory = createMarvMem({
  searchWeights: {
    lexical: 0.5,
    hash: 0.3,
    recency: 0.1,
    importance: 0.05,
    scope: 0.05,
  },
});
```

### 召回长度

无论直接用 `memory.recall()`，还是走 `runtime.buildRecallContext()` 或 MCP 的 `memory_recall`，都可以控制输出长度：

```ts
maxChars: 800
```

## 10. 测试或临时运行时怎么用

不想落盘时，用 `InMemoryStore`：

```ts
import { createMarvMem, InMemoryStore } from "marvmem";

const memory = createMarvMem({
  store: new InMemoryStore(),
});
```

这个适合：

- 单元测试
- 临时 agent session
- demo

## 11. 当前限制

- 底层存储目前是 JSON 文件，不是 SQLite
- 搜索是本地确定性 hash 检索，不是远程 embedding
- runtime 抽取规则是轻量启发式
- adapter 层刻意保持很薄，不做重封装

## 12. 推荐接法

如果你只是要一个稳定、简单、可控的长期记忆层，建议这样选：

- 单进程应用：`createMarvMem()` + `createMemoryRuntime()`
- 需要给外部 agent 暴露工具：加 `createMemoryMcpHandler()`
- 已经有固定 agent 框架：直接上对应 adapter

如果你后面准备把它公开到 GitHub，这份文档可以和 `README.md` 一起提交。
