import test from "node:test";
import assert from "node:assert/strict";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";
import { RetrievalManager } from "../src/retrieval/index.js";
import { createMemoryRuntime } from "../src/runtime/index.js";

test("runtime combines active memory and task context layers", async () => {
  const memory = createMarvMem({
    store: new InMemoryStore(),
    inferencer: async ({ kind, prompt }) => ({
      ok: true,
      text:
        kind === "context"
          ? `Current focus: ${prompt.slice(0, 60)}`
          : kind === "task_summary"
            ? `Task summary: ${prompt.slice(0, 60)}`
            : `Experience note: ${prompt.slice(0, 60)}`,
    }),
  });
  const runtime = createMemoryRuntime({
    memory,
    defaultScopes: [{ type: "task", id: "launch", weight: 1 }],
  });

  await runtime.captureTurn({
    taskId: "release",
    taskTitle: "Release checklist",
    userMessage: "We are drafting the release checklist for the public launch.",
    assistantMessage: "I will keep the checklist concise and action-oriented.",
  });
  await runtime.captureReflection({
    summary: "Prefer concise release checklists with only actionable items.",
    scopes: [{ type: "task", id: "launch" }],
    taskId: "release",
  });

  const recall = await runtime.buildRecallContext({
    taskId: "release",
    userMessage: "What should I focus on for this launch task?",
    toolContext: "Open items: checklist, docs, QA handoff.",
    scopes: [{ type: "task", id: "launch" }],
  });

  assert.match(recall.injectedContext, /Active context:/);
  assert.match(recall.injectedContext, /Active experience:/);
  assert.match(recall.injectedContext, /Task summary:/);
  assert.match(recall.injectedContext, /Key decisions:/);
});

test("retrieval manager can rerank builtin hits with an embedding provider", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });

  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "note",
    content: "Alpha apples only.",
    importance: 1,
  });
  await memory.remember({
    scope: { type: "user", id: "alice" },
    kind: "note",
    content: "Beta oranges only.",
    importance: 0,
  });

  const raw = await memory.search("totally unrelated query", {
    scopes: [{ type: "user", id: "alice" }],
    maxResults: 2,
    minScore: 0,
  });
  assert.equal(raw[0]?.record.content, "Alpha apples only.");

  const retrieval = new RetrievalManager({
    memory,
    embeddingProvider: {
      id: "mock",
      async embedQuery() {
        return [1];
      },
      async embedDocuments(texts) {
        return texts.map((text) => (text.includes("Beta") ? [1] : [0]));
      },
    },
  });

  const reranked = await retrieval.search("totally unrelated query", {
    scopes: [{ type: "user", id: "alice" }],
    maxResults: 2,
    minScore: 0,
  });
  assert.equal(reranked[0]?.record?.content, "Beta oranges only.");
});

test("experience calibration removes stale entries that are not supported by palace memory", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const scope = { type: "task" as const, id: "launch" };

  await memory.remember({
    scope,
    kind: "lesson",
    content: "Keep release checklists short and actionable.",
  });
  await memory.active.write({
    kind: "experience",
    scope,
    content: "Keep release checklists short and actionable.\nStale unused habit.",
  });

  await memory.maintenance.attributeExperience({
    scope,
    response: "Keep release checklists short and actionable in the final prompt.",
    outcome: "positive",
  });

  const calibration = await memory.maintenance.calibrateExperience({ scope });
  const experience = await memory.active.read("experience", scope);

  assert.deepEqual(calibration.zombieRemoved, ["Stale unused habit."]);
  assert.ok(experience);
  assert.doesNotMatch(experience!.content, /Stale unused habit/);
});
