# WorkBuddy 普通用户安装教程

这份教程适合只想把 MarvMem 接到 WorkBuddy 里使用的用户。完成后，WorkBuddy 会多出一个 `marvmem` MCP 服务，可以搜索和召回同一台电脑上的 MarvMem 记忆库。

## 你会得到什么

- WorkBuddy 里出现 `marvmem` MCP 服务
- 15 个 MarvMem 工具全部启用
- 新写入的 WorkBuddy 记忆默认进入 `agent:workbuddy`
- 原有 `~/.workbuddy/SOUL.md`、`USER.md`、`MEMORY.md` 会被导入 MarvMem，并继续作为 Markdown 映射文件保留
- 不传 scope 的搜索和召回可以读取共享记忆库，例如以前由 Codex、Claude Code、Antigravity 写入的记忆

默认记忆库位置：

```text
~/.marvmem/memory.sqlite
```

## 准备工作

确认本机有 Node.js 22.13.0 或更高版本：

```bash
node -v
```

如果版本太低，请先升级 Node.js。

## 安装 MarvMem

选择一个你平时放项目的目录，然后克隆并构建 MarvMem：

```bash
git clone https://github.com/daisyluvr42/marvmem.git
cd marvmem
npm install
npm run build
```

如果你已经有本地 MarvMem 仓库，直接更新并重新构建：

```bash
cd /path/to/marvmem
git pull --ff-only
npm install
npm run build
```

## 接入 WorkBuddy

在 MarvMem 仓库目录里运行：

```bash
node dist/bin/marvmem-agent.js install workbuddy
```

这个命令会写入：

```text
~/.workbuddy/mcp.json
```

它也会先接管 WorkBuddy 的三份 Markdown 记忆文件：

```text
~/.workbuddy/SOUL.md
~/.workbuddy/USER.md
~/.workbuddy/MEMORY.md
```

接管后，主要记忆存储在 MarvMem 数据库中；这三份文件仍留在原位置，作为 WorkBuddy 可继续读取的 Markdown 映射。每次 WorkBuddy 通过 MarvMem 写入记忆时，MarvMem 会先吸收这三份文件里的直接改动，再刷新映射内容，尽量不改变原有使用体验。

配置大致长这样：

```json
{
  "mcpServers": {
    "marvmem": {
      "command": "node",
      "args": ["/absolute/path/to/marvmem/dist/bin/marvmem-mcp.js"],
      "env": {
        "MARVMEM_STORAGE_PATH": "/Users/you/.marvmem/memory.sqlite",
        "MARVMEM_SCOPE_TYPE": "agent",
        "MARVMEM_SCOPE_ID": "workbuddy",
        "MARVMEM_WORKBUDDY_HOME": "/Users/you/.workbuddy"
      }
    }
  }
}
```

你一般不需要手动编辑这个文件。

## 在 WorkBuddy 里启用

打开 WorkBuddy，然后进入：

```text
连接器 -> 自定义连接器 -> MCP 服务管理
```

找到 `marvmem`，打开开关。如果 WorkBuddy 提示信任或启用这个 MCP 服务，点击信任。

成功后应该能看到：

```text
marvmem
15/15 个工具已启用
```

如果没有看到绿色启用状态，可以点击刷新按钮，或退出并重新打开 WorkBuddy。

## 做一次测试

在 WorkBuddy 里新建任务，输入：

```text
请调用 marvmem_memory_recall，不要使用 conversation_search。不要传 scopeType/scopeId。召回我们之前写过的长期记忆，列出你找到的记录来源、scope 和核心内容。
```

如果你已经有 MarvMem 旧记忆，也可以问更具体的问题，例如：

```text
请调用 marvmem_memory_recall，不要使用 conversation_search。不要传 scopeType/scopeId。召回我们之前写腾讯文章时形成的独特观点，重点找判断框架、管理层话外音、估值逻辑、多情景目标价和可直接写进文章的核心句子。
```

正常情况下，WorkBuddy 会调用 `marvmem_memory_recall` 或 `marvmem_memory_search`，而不是只搜索 WorkBuddy 自己的历史对话。

## 日常怎么用

你可以直接用自然语言要求 WorkBuddy 访问记忆：

```text
请用 MarvMem 召回我之前对这个项目的决定。
```

```text
请把这次任务的关键结论写入 MarvMem。
```

```text
请从 MarvMem 里找出我以前关于这篇文章风格的要求。
```

更稳定的写法是直接点名工具：

```text
请调用 marvmem_memory_recall，不要传 scopeType/scopeId，召回……
```

写入新记忆时不需要传 scope。MarvMem 会自动写到 `agent:workbuddy`：

```text
请调用 marvmem_memory_write，记住：我希望这类任务先给结论，再给证据。
```

## 更新 MarvMem

以后要更新本机 MarvMem：

```bash
cd /path/to/marvmem
git pull --ff-only
npm install
npm run build
node dist/bin/marvmem-agent.js install workbuddy
```

然后在 WorkBuddy 的 MCP 服务管理里刷新或重新启用 `marvmem`。

## 常见问题

### WorkBuddy 说找不到 MarvMem 记忆库

先看它是不是用了 MarvMem 工具。如果它只用了 `conversation_search`，说明它在搜 WorkBuddy 自己的对话历史，不是在搜 MarvMem。

可以这样问：

```text
请调用 marvmem_memory_recall，不要使用 conversation_search。不要传 scopeType/scopeId。
```

### WorkBuddy 能看到 marvmem，但没有结果

可能是记忆库里还没有相关内容。先写一条测试记忆：

```text
请调用 marvmem_memory_write，记住：WorkBuddy 已经成功接入 MarvMem。
```

再召回：

```text
请调用 marvmem_memory_recall，查询 WorkBuddy 已经成功接入 MarvMem。
```

### marvmem 显示未信任或未启用

进入：

```text
连接器 -> 自定义连接器 -> MCP 服务管理
```

打开 `marvmem` 开关，并点击信任。WorkBuddy 会把信任记录写入：

```text
~/.workbuddy/mcp-approvals.json
```

这个文件通常不需要手动改。

### 想确认配置写对了

查看：

```bash
cat ~/.workbuddy/mcp.json
```

应该能看到 `marvmem`，并且 `args` 指向你的本地 `dist/bin/marvmem-mcp.js`。

### 想确认 MarvMem 自己能运行

在 MarvMem 仓库目录里运行：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/bin/marvmem-mcp.js
```

如果输出里能看到 `memory_recall`、`memory_search`、`memory_write` 等工具，说明 MarvMem MCP server 本身正常。
