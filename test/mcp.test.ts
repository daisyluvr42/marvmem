import test from "node:test";
import assert from "node:assert/strict";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";
import { createMemoryMcpHandler } from "../src/mcp/index.js";

test("lists MCP tools and executes write/search flow", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  const list = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })) as { result?: { tools?: Array<{ name: string; inputSchema: { required?: string[] } }> } };

  const toolNames = list.result?.tools?.map((tool) => tool.name) ?? [];
  const deleteTool = list.result?.tools?.find((tool) => tool.name === "memory_delete");
  assert.ok(toolNames.includes("memory_search"));
  assert.ok(toolNames.includes("memory_get"));
  assert.ok(toolNames.includes("memory_write"));
  assert.ok(toolNames.includes("memory_recall"));
  assert.ok(toolNames.includes("memory_list"));
  assert.ok(toolNames.includes("memory_update"));
  assert.ok(toolNames.includes("memory_delete"));
  assert.ok(toolNames.includes("memory_session_commit"));
  assert.deepEqual(deleteTool?.inputSchema.required, ["id", "scopeType", "scopeId"]);

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        content: "User prefers concise Chinese replies.",
        kind: "preference",
        scopeType: "user",
        scopeId: "alice",
        source: "codex_session_import",
        tags: ["codex", "session"],
        metadata: {
          sessionId: "s1",
          cwd: "/repo",
        },
      },
    },
  });

  const search = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_search",
      arguments: {
        query: "What language should I reply in?",
        scopeType: "user",
        scopeId: "alice",
      },
    },
  })) as {
    result?: { content?: Array<{ text: string }> };
  };

  const parsed = JSON.parse(search.result?.content?.[0]?.text ?? "{}");
  assert.equal(parsed.hits?.length, 1);
  assert.match(parsed.hits?.[0]?.record.content ?? "", /Chinese/);
  assert.equal(parsed.hits?.[0]?.record.source, "codex_session_import");
  assert.deepEqual(parsed.hits?.[0]?.record.tags, ["codex", "session"]);
  assert.deepEqual(parsed.hits?.[0]?.record.metadata, { sessionId: "s1", cwd: "/repo" });
});

test("MCP write and scope-bound tools use configured default scope", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({
    memory,
    defaultScopes: [{ type: "agent", id: "workbuddy" }],
  });

  const list = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })) as { result?: { tools?: Array<{ name: string; inputSchema: { required?: string[] } }> } };
  const writeTool = list.result?.tools?.find((tool) => tool.name === "memory_write");
  assert.deepEqual(writeTool?.inputSchema.required, ["content"]);

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        content: "WorkBuddy should use the configured default scope.",
        kind: "preference",
      },
    },
  });

  const search = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_search",
      arguments: {
        query: "configured default scope",
        scopeType: "agent",
        scopeId: "workbuddy",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const parsed = JSON.parse(search.result?.content?.[0]?.text ?? "{}");
  assert.equal(parsed.hits?.[0]?.record.scope.type, "agent");
  assert.equal(parsed.hits?.[0]?.record.scope.id, "workbuddy");

  const active = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "memory_active_distill",
      arguments: {
        kind: "context",
        content: "WorkBuddy active context.",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const activeParsed = JSON.parse(active.result?.content?.[0]?.text ?? "{}");
  assert.equal(activeParsed.document.scope.id, "workbuddy");
});

test("MCP read tools with a default write scope still search shared memory", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({
    memory,
    defaultScopes: [{ type: "agent", id: "workbuddy" }],
  });

  await memory.remember({
    scope: { type: "agent", id: "codex" },
    content: "Tencent article thesis: valuation is shifting from platform PE to AI application optionality.",
    source: "codex_session_import",
  });

  const recallResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_recall",
      arguments: {
        message: "Tencent article valuation thesis",
        maxChars: 1000,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const recall = JSON.parse(recallResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(recall.hits?.[0]?.record.scope.id, "codex");
  assert.match(recall.injectedContext, /AI application optionality/);
});

test("MCP update and delete stay within the configured default scope", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({
    memory,
    defaultScopes: [{ type: "agent", id: "workbuddy" }],
  });

  const codexRecord = await memory.remember({
    scope: { type: "agent", id: "codex" },
    content: "Codex-owned memory should not be deleted by WorkBuddy.",
  });
  const workbuddyRecord = await memory.remember({
    scope: { type: "agent", id: "workbuddy" },
    content: "WorkBuddy-owned memory can be updated by WorkBuddy.",
  });

  const deniedDelete = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_delete",
      arguments: { id: codexRecord.id },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  assert.equal(JSON.parse(deniedDelete.result?.content?.[0]?.text ?? "{}").deleted, false);
  assert.ok(await memory.get(codexRecord.id));

  const deniedScope = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_delete",
      arguments: { id: codexRecord.id, scopeType: "agent", scopeId: "codex" },
    },
  })) as { error?: { message?: string } };

  assert.match(deniedScope.error?.message ?? "", /configured default scope/);

  const update = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_update",
      arguments: { id: workbuddyRecord.id, content: "Updated by WorkBuddy." },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const updated = JSON.parse(update.result?.content?.[0]?.text ?? "{}");
  assert.equal(updated.updated, true);
  assert.equal(updated.record.content, "Updated by WorkBuddy.");
});

test("memory_recall exposes record markers through MCP", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        content: "Cursor session established the release checklist.",
        kind: "decision",
        scopeType: "agent",
        scopeId: "cursor",
        source: "cursor_session_import",
        tags: ["cursor", "session", "release"],
        metadata: {
          sessionId: "cursor-1",
          taskId: "cursor-session-cursor-1",
        },
      },
    },
  });

  const recallResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_recall",
      arguments: {
        message: "release checklist",
        maxChars: 1000,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const recall = JSON.parse(recallResult.result?.content?.[0]?.text ?? "{}");
  assert.match(recall.injectedContext, /source: cursor_session_import/);
  assert.match(recall.injectedContext, /tags: cursor, session, release/);
  assert.match(recall.injectedContext, /"sessionId":"cursor-1"/);
  assert.match(recall.navigationContext, /memory_get/);
  assert.equal(recall.hits?.[0]?.record.source, "cursor_session_import");
  assert.equal(recall.hits?.[0]?.evidence?.tools?.[0]?.name, "memory_get");
  assert.deepEqual(recall.hits?.[0]?.record.metadata, {
    sessionId: "cursor-1",
    taskId: "cursor-session-cursor-1",
  });
});

test("memory_list and memory_delete work through MCP", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  // Write a record
  const writeResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        content: "Test memory for deletion.",
        kind: "fact",
        scopeType: "user",
        scopeId: "bob",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const written = JSON.parse(writeResult.result?.content?.[0]?.text ?? "{}");
  const recordId = written.record?.id;
  assert.ok(recordId);

  // List should return it
  const listResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_list",
      arguments: { scopeType: "user", scopeId: "bob" },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const listed = JSON.parse(listResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(listed.records?.length, 1);

  // Delete it
  const deleteResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_delete",
      arguments: { id: recordId, scopeType: "user", scopeId: "bob" },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const deleted = JSON.parse(deleteResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(deleted.deleted, true);

  // List should be empty now
  const listAfter = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "memory_list",
      arguments: { scopeType: "user", scopeId: "bob" },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const listedAfter = JSON.parse(listAfter.result?.content?.[0]?.text ?? "{}");
  assert.equal(listedAfter.records?.length, 0);
});

test("memory_session_commit stores host-distilled session state without calling an inferencer", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  const firstCommit = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_session_commit",
      arguments: {
        agent: "codex",
        sessionId: "session-commit-1",
        cwd: "/repo",
        timestamp: "2026-05-02T00:00:00.000Z",
        messageCount: 2,
        rollingSummary: "Host summary: importer now commits session summaries.",
        scopeType: "agent",
        scopeId: "codex",
        entries: [
          { role: "user", content: "Please implement host-mediated distill." },
          { role: "assistant", content: "Implemented a commit tool." },
        ],
        durableMemories: [
          {
            kind: "decision",
            content: "MarvMem host-mediated distill stores summaries supplied by the host agent.",
            scopeType: "project",
            scopeId: "marvmem",
            tags: ["host-distill"],
          },
        ],
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const first = JSON.parse(firstCommit.result?.content?.[0]?.text ?? "{}");
  assert.equal(first.appendedEntries, 2);
  assert.equal(first.sessionRecord?.metadata?.messageCount, 2);
  assert.equal(first.sessionRecord?.metadata?.commitSource, "host");
  assert.equal(first.durableRecords?.length, 1);

  const state = await memory.task.getRollingSummary("codex:session-commit-1");
  assert.equal(state?.rollingSummary, "Host summary: importer now commits session summaries.");
  const entries = await memory.task.listEntries("codex:session-commit-1");
  assert.equal(entries.length, 2);
  assert.equal(entries.every((entry) => entry.summarized), true);

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_session_commit",
      arguments: {
        agent: "codex",
        sessionId: "session-commit-1",
        messageCount: 2,
        rollingSummary: "Host summary: same session, no new messages.",
        scopeType: "agent",
        scopeId: "codex",
        entries: [{ role: "user", content: "This should not duplicate." }],
      },
    },
  });
  assert.equal((await memory.task.listEntries("codex:session-commit-1")).length, 2);

  const resumedCommit = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_session_commit",
      arguments: {
        agent: "codex",
        sessionId: "session-commit-1",
        messageCount: 4,
        rollingSummary: "Host summary: resumed session appended a delta.",
        scopeType: "agent",
        scopeId: "codex",
        entries: [
          { role: "user", content: "Continue this session later." },
          { role: "assistant", content: "Only the delta is appended." },
        ],
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const resumed = JSON.parse(resumedCommit.result?.content?.[0]?.text ?? "{}");
  assert.equal(resumed.appendedEntries, 2);
  assert.equal(resumed.sessionRecord?.metadata?.messageCount, 4);
  assert.equal(resumed.sessionRecord?.metadata?.resumeCount, 1);
  assert.match(resumed.sessionRecord?.content ?? "", /resumed session appended/);
  assert.equal((await memory.task.listEntries("codex:session-commit-1")).length, 4);

  const projectRecords = await memory.list({ scopes: [{ type: "project", id: "marvmem" }] });
  assert.equal(projectRecords.length, 1);
  assert.equal(projectRecords[0]?.metadata?.origin, "host_session_commit");
});

test("memory_recall respects maxChars through MCP", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_write",
      arguments: {
        content: "alpha ".repeat(100).trim(),
        scopeType: "user",
        scopeId: "alice",
      },
    },
  });

  const recallResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_recall",
      arguments: {
        message: "alpha",
        scopeType: "user",
        scopeId: "alice",
        maxChars: 40,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const recall = JSON.parse(recallResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(recall.injectedContext, "Relevant long-term memory:\nUse these memories as supporting context.");
});
