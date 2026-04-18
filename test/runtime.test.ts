import test from "node:test";
import assert from "node:assert/strict";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";
import { createMemoryRuntime } from "../src/runtime/index.js";

test("captures explicit remember requests", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const runtime = createMemoryRuntime({
    memory,
    defaultScopes: [{ type: "user", id: "alice", weight: 1.05 }],
  });

  const capture = await runtime.captureTurn({
    userMessage: "Remember that I prefer concise Chinese replies.",
  });

  assert.equal(capture.stored.length, 2);
  const hits = await memory.search("language preference", {
    scopes: [{ type: "user", id: "alice", weight: 1.05 }],
  });
  assert.ok(hits.length >= 1);
});

test("builds recall context through the runtime layer", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const runtime = createMemoryRuntime({
    memory,
    defaultScopes: [{ type: "task", id: "marvmem", weight: 1 }],
  });

  await runtime.captureReflection({
    summary: "We decided MarvMem should favor easy adapter APIs over Marv-specific internals.",
  });

  const recall = await runtime.buildRecallContext({
    userMessage: "What was the main API goal again?",
  });

  assert.match(recall.injectedContext, /easy adapter APIs/);
});

