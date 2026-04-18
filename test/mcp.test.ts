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
  })) as { result?: { tools?: Array<{ name: string }> } };

  const toolNames = list.result?.tools?.map((tool) => tool.name) ?? [];
  assert.ok(toolNames.includes("memory_search"));
  assert.ok(toolNames.includes("memory_get"));
  assert.ok(toolNames.includes("memory_write"));
  assert.ok(toolNames.includes("memory_recall"));
  assert.ok(toolNames.includes("memory_list"));
  assert.ok(toolNames.includes("memory_update"));
  assert.ok(toolNames.includes("memory_delete"));

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
      arguments: { id: recordId },
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
