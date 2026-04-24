import test from "node:test";
import assert from "node:assert/strict";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";
import { LlmMemoryProposalExtractor, createMemoryRuntime } from "../src/runtime/index.js";

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

test("trims follow-up questions from remembered preferences", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const runtime = createMemoryRuntime({
    memory,
    defaultScopes: [{ type: "user", id: "alice" }],
  });

  await runtime.captureTurn({
    userMessage:
      "Remember that I prefer numbered lists and quiet shells. What reply style should you use for me?",
  });

  const hits = await memory.search("numbered lists quiet shells", {
    scopes: [{ type: "user", id: "alice" }],
    maxResults: 10,
    minScore: 0,
  });
  const contents = hits.map((hit) => hit.record.content);

  assert.ok(contents.includes("I prefer numbered lists and quiet shells."));
  assert.ok(
    contents.every((content) => !content.includes("What reply style should you use for me?")),
  );
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

test("optional LLM proposal extractor can capture structured memories", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const runtime = createMemoryRuntime({
    memory,
    defaultScopes: [{ type: "user", id: "alice" }],
    proposalExtractor: new LlmMemoryProposalExtractor(async () => ({
      ok: true,
      text: JSON.stringify([
        {
          kind: "preference",
          content: "Alice prefers terse status updates.",
          tags: ["style"],
        },
      ]),
    })),
  });

  const result = await runtime.captureTurn({
    userMessage: "For future updates, keep it terse.",
  });

  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0]!.content, "Alice prefers terse status updates.");
});
