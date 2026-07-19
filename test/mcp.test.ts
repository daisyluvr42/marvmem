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
  const recordTool = list.result?.tools?.find((tool) => tool.name === "memory_record");
  assert.deepEqual(toolNames.toSorted(), [
    "memory_active",
    "memory_context",
    "memory_maintenance",
    "memory_record",
    "memory_session",
    "memory_task",
  ]);
  assert.deepEqual(recordTool?.inputSchema.required, ["action"]);

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
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
      name: "memory_record",
      arguments: {
        action: "search",
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
  const recordTool = list.result?.tools?.find((tool) => tool.name === "memory_record");
  assert.deepEqual(recordTool?.inputSchema.required, ["action"]);

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
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
      name: "memory_record",
      arguments: {
        action: "search",
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
      name: "memory_active",
      arguments: {
        action: "distill",
        kind: "context",
        content: "WorkBuddy active context.",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const activeParsed = JSON.parse(active.result?.content?.[0]?.text ?? "{}");
  assert.equal(activeParsed.document.scope.id, "workbuddy");
});

test("MCP initialize derives a default agent scope from clientInfo.name", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Claude Code", version: "1.0.0" },
    },
  });
  const write = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
        content: "The initialized client can write without an explicit scope.",
        kind: "fact",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const parsed = JSON.parse(write.result?.content?.[0]?.text ?? "{}");
  assert.deepEqual(parsed.record?.scope, { type: "agent", id: "claude" });
});

test("MCP mutating tools can trigger projection sync callbacks", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  let syncs = 0;
  const handler = createMemoryMcpHandler({
    memory,
    defaultScopes: [{ type: "agent", id: "workbuddy" }],
    onMemoryChanged: async () => {
      syncs += 1;
    },
  });

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
        content: "WorkBuddy projection should refresh after writes.",
      },
    },
  });

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_context",
      arguments: {
        action: "recall",
        message: "projection refresh",
      },
    },
  });

  assert.equal(syncs, 1);
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
      name: "memory_context",
      arguments: {
        action: "recall",
        message: "Tencent article valuation thesis",
        maxChars: 1000,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const recall = JSON.parse(recallResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(recall.hits?.[0]?.scope.id, "codex");
  assert.match(recall.injectedContext, /AI application optionality/);
  assert.equal(recall.hits?.[0]?.content, undefined);
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
      name: "memory_record",
      arguments: {
        action: "delete", id: codexRecord.id },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  assert.equal(JSON.parse(deniedDelete.result?.content?.[0]?.text ?? "{}").deleted, false);
  assert.ok(await memory.get(codexRecord.id));

  const deniedScope = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "delete", id: codexRecord.id, scopeType: "agent", scopeId: "codex" },
    },
  })) as { error?: { message?: string } };

  assert.match(deniedScope.error?.message ?? "", /configured default scope/);

  const update = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "update", id: workbuddyRecord.id, content: "Updated by WorkBuddy." },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const updated = JSON.parse(update.result?.content?.[0]?.text ?? "{}");
  assert.equal(updated.updated, true);
  assert.equal(updated.record.content, "Updated by WorkBuddy.");
});

test("MCP rejects unsupported scopeType but allows custom agent scopeId", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  const invalid = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
        content: "Custom agents should use the agent scope type.",
        scopeType: "custom-agent",
        scopeId: "default",
      },
    },
  })) as { error?: { message?: string } };

  assert.match(invalid.error?.message ?? "", /Unsupported scopeType: custom-agent/);
  assert.match(invalid.error?.message ?? "", /For a new or custom agent/);

  const valid = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
        content: "Custom agent memory.",
        scopeType: "agent",
        scopeId: "custom-agent",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const parsed = JSON.parse(valid.result?.content?.[0]?.text ?? "{}");
  assert.equal(parsed.record?.scope?.type, "agent");
  assert.equal(parsed.record?.scope?.id, "custom-agent");
});

test("memory_context exposes record markers through MCP", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
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
      name: "memory_context",
      arguments: {
        action: "recall",
        message: "release checklist",
        maxChars: 1000,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const recall = JSON.parse(recallResult.result?.content?.[0]?.text ?? "{}");
  assert.match(recall.injectedContext, /source: cursor_session_import/);
  assert.match(recall.injectedContext, /tags: cursor, session, release/);
  assert.equal(recall.navigationContext, undefined);
  assert.equal(recall.evidence, undefined);
  assert.equal(recall.layers, undefined);
  assert.equal(recall.hits?.[0]?.source, "cursor_session_import");

  const exactResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "get",
        id: recall.hits?.[0]?.id,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const exact = JSON.parse(exactResult.result?.content?.[0]?.text ?? "{}");
  assert.deepEqual(exact.record.metadata, {
    sessionId: "cursor-1",
    taskId: "cursor-session-cursor-1",
  });
});

test("memory_record list and delete work through MCP", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  // Write a record
  const writeResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
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
      name: "memory_record",
      arguments: {
        action: "list", scopeType: "user", scopeId: "bob" },
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
      name: "memory_record",
      arguments: {
        action: "delete", id: recordId, scopeType: "user", scopeId: "bob" },
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
      name: "memory_record",
      arguments: {
        action: "list", scopeType: "user", scopeId: "bob" },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const listedAfter = JSON.parse(listAfter.result?.content?.[0]?.text ?? "{}");
  assert.equal(listedAfter.records?.length, 0);

  const tombstoneResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "get",
        id: recordId,
        includeDeleted: true,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const tombstone = JSON.parse(tombstoneResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(typeof tombstone.record?.deletedAt, "string");
  assert.equal(tombstone.record?.deletedBy, "mcp:user:bob");

  const restoreResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "restore",
        id: recordId,
        scopeType: "user",
        scopeId: "bob",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const restored = JSON.parse(restoreResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(restored.restored, true);
  assert.equal(restored.record?.deletedAt, undefined);
});

test("memory_session stores host-distilled session state without calling an inferencer", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  const firstCommit = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_session",
      arguments: {
        action: "commit",
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
  assert.equal(first.active?.context?.content, "Host summary: importer now commits session summaries.");
  assert.equal(first.active?.context?.metadata?.lastGovernedBy, "codex");
  assert.equal(first.maintenanceRequest?.kind, "active_memory_maintenance");

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
      name: "memory_session",
      arguments: {
        action: "commit",
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
      name: "memory_session",
      arguments: {
        action: "commit",
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

test("memory_session active governance can be deep-maintained by the host", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  const commitResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_session",
      arguments: {
        action: "commit",
        agent: "workbuddy",
        sessionId: "governance-1",
        rollingSummary: "The session discussed active memory governance.",
        activeContext: "Current context after host light governance.",
        activeExperience: "Reusable lesson after host light governance.",
        governanceReport: { removedDuplicates: 1 },
        scopeType: "agent",
        scopeId: "workbuddy",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const commit = JSON.parse(commitResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(commit.active?.context?.content, "Current context after host light governance.");
  assert.equal(commit.active?.experience?.content, "Reusable lesson after host light governance.");
  assert.equal(commit.active?.experience?.metadata?.governanceReport?.removedDuplicates, 1);
  assert.equal(commit.maintenanceRequest?.kind, "active_memory_maintenance");
  assert.deepEqual(commit.maintenanceRequest?.palaceRecords, []);

  const prepareResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_maintenance",
      arguments: {
        action: "prepare",
        scopeType: "agent",
        scopeId: "workbuddy",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const prepared = JSON.parse(prepareResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(prepared.request?.active?.context?.content, "Current context after host light governance.");

  const applyResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "memory_maintenance",
      arguments: {
        action: "apply",
        agent: "workbuddy",
        activeContext: "Deep-governed active context.",
        activeExperience: "Deep-governed active experience.",
        governanceReport: { correctedAgainstPalace: true },
        scopeType: "agent",
        scopeId: "workbuddy",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const applied = JSON.parse(applyResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(applied.context?.content, "Deep-governed active context.");
  assert.equal(applied.experience?.metadata?.lastGovernedBy, "workbuddy");
  assert.ok(applied.experience?.metadata?.lastDeepGovernedAt);

  const secondCommit = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "memory_session",
      arguments: {
        action: "commit",
        agent: "workbuddy",
        sessionId: "governance-1",
        rollingSummary: "A later session commit still refreshes active context.",
        activeContext: "Fresh light-governed active context.",
        scopeType: "agent",
        scopeId: "workbuddy",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const second = JSON.parse(secondCommit.result?.content?.[0]?.text ?? "{}");
  assert.equal(second.maintenanceRequest, undefined);
});

test("maintenance exposes cross-scope conflicts and can supersede stale palace records", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });
  const stale = await memory.remember({
    scope: { type: "agent", id: "codex" },
    kind: "fact",
    content: "WorkBuddy instruction file is MEMORY.md.",
    source: "codex",
  });
  const current = await memory.remember({
    scope: { type: "repo", id: "marvmem" },
    kind: "repo_fact",
    content: "WorkBuddy instruction file is now SOUL.md instead of MEMORY.md.",
    source: "repo",
  });

  const prepareResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_maintenance",
      arguments: {
        action: "prepare",
        scopeType: "agent",
        scopeId: "codex",
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const prepared = JSON.parse(prepareResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(
    prepared.request?.conflictCandidates?.some(
      (candidate: { left?: { id?: string }; right?: { id?: string } }) =>
        [candidate.left?.id, candidate.right?.id].includes(stale.id) &&
        [candidate.left?.id, candidate.right?.id].includes(current.id),
    ),
    true,
  );

  const applyResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_maintenance",
      arguments: {
        action: "apply",
        agent: "codex",
        activeContext: "WorkBuddy instructions now live in SOUL.md.",
        scopeType: "agent",
        scopeId: "codex",
        recordActions: [
          {
            action: "supersede",
            id: stale.id,
            winnerId: current.id,
            scopeType: "agent",
            scopeId: "codex",
            reason: "Repository state supersedes the older agent memory.",
          },
        ],
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const applied = JSON.parse(applyResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(applied.recordActions?.[0]?.applied, true);
  assert.equal(await memory.get(stale.id), null);
  assert.equal((await memory.get(stale.id, { includeDeleted: true }))?.supersededBy, current.id);
});

test("memory_context respects maxChars through MCP", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });

  await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_record",
      arguments: {
        action: "write",
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
      name: "memory_context",
      arguments: {
        action: "recall",
        message: "alpha",
        scopeType: "user",
        scopeId: "alice",
        maxChars: 40,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };

  const recall = JSON.parse(recallResult.result?.content?.[0]?.text ?? "{}");
  assert.equal(recall.injectedContext.length <= 40, true);
  assert.equal(recall.injectedContext, "Relevant long-term memory:\nUse these mem");
});

test("default memory_context response stays compact unless verbose is requested", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const handler = createMemoryMcpHandler({ memory });
  for (let index = 0; index < 8; index += 1) {
    await memory.remember({
      scope: { type: "repo", id: `repo-${index}` },
      kind: "fact",
      content: `Compact recall fact ${index} about WorkBuddy memory governance.`,
      summary: `WorkBuddy memory governance fact ${index}`,
      metadata: { payload: "x".repeat(2_000) },
    }, { dedupe: false });
  }

  const compactResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "memory_context",
      arguments: {
        action: "recall",
        message: "WorkBuddy memory governance",
        maxChars: 2_000,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const compactText = compactResult.result?.content?.[0]?.text ?? "";
  const compact = JSON.parse(compactText);
  assert.equal(compactText.length < 6_000, true);
  assert.equal(compact.layers, undefined);
  assert.equal(compact.evidence, undefined);

  const verboseResult = (await handler.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "memory_context",
      arguments: {
        action: "recall",
        message: "WorkBuddy memory governance",
        maxChars: 2_000,
        verbose: true,
      },
    },
  })) as { result?: { content?: Array<{ text: string }> } };
  const verbose = JSON.parse(verboseResult.result?.content?.[0]?.text ?? "{}");
  assert.ok(verbose.layers);
  assert.ok(verbose.evidence);
});
