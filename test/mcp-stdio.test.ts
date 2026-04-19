import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";
import { runMemoryMcpStdioServer } from "../src/mcp/index.js";

test("stdio MCP server negotiates protocol version and handles tool calls", async () => {
  const stdin = new PassThrough();
  let stdoutData = "";
  let stderrData = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutData += chunk.toString();
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrData += chunk.toString();
      callback();
    },
  });

  const memory = createMarvMem({ store: new InMemoryStore() });
  const server = runMemoryMcpStdioServer({ memory, stdin, stdout, stderr });

  stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }) + "\n",
  );
  stdin.write(
    JSON.stringify({
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
    }) + "\n",
  );
  stdin.end();

  await server;

  const messages = stdoutData
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(messages[0]?.result?.protocolVersion, "2025-06-18");
  assert.match(messages[0]?.result?.instructions ?? "", /memory_recall/);

  const writePayload = JSON.parse(messages[1]?.result?.content?.[0]?.text ?? "{}");
  assert.equal(writePayload.record?.scope?.type, "user");
  assert.equal(writePayload.record?.scope?.id, "alice");
  assert.match(writePayload.record?.content ?? "", /concise Chinese/);

  assert.equal(stderrData, "");
});
