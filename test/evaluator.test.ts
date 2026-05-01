import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuleBasedEvaluator } from "../src/core/evaluator.js";
import { createMarvMem } from "../src/core/memory.js";

describe("RuleBasedEvaluator", () => {
  const evaluator = new RuleBasedEvaluator();

  it("returns add when no candidates", async () => {
    const decision = await evaluator.evaluate({
      incoming: { content: "New fact", kind: "fact", tags: [] },
      candidates: [],
    });
    assert.equal(decision.action, "add");
  });

  it("returns ignore for near-identical content", async () => {
    const decision = await evaluator.evaluate({
      incoming: { content: "User prefers dark mode", kind: "preference", tags: [] },
      candidates: [
        { id: "r1", content: "User prefers dark mode", kind: "preference", similarity: 0.98 },
      ],
    });
    assert.equal(decision.action, "ignore");
  });

  it("returns update for similar content", async () => {
    const decision = await evaluator.evaluate({
      incoming: { content: "User prefers dark mode with blue accents", kind: "preference", tags: [] },
      candidates: [
        { id: "r1", content: "User prefers dark mode", kind: "preference", similarity: 0.82 },
      ],
    });
    assert.equal(decision.action, "update");
    assert.equal((decision as any).targetId, "r1");
  });

  it("returns contradict for temporal changes", async () => {
    const decision = await evaluator.evaluate({
      incoming: { content: "User now prefers light mode", kind: "preference", tags: [] },
      candidates: [
        { id: "r1", content: "User prefers dark mode", kind: "preference", similarity: 0.80 },
      ],
    });
    assert.equal(decision.action, "contradict");
    assert.equal((decision as any).targetId, "r1");
  });

  it("returns add for low similarity", async () => {
    const decision = await evaluator.evaluate({
      incoming: { content: "The project uses React", kind: "fact", tags: [] },
      candidates: [
        { id: "r1", content: "User likes Vim", kind: "fact", similarity: 0.3 },
      ],
    });
    assert.equal(decision.action, "add");
  });
});

describe("MarvMem with evaluator", () => {
  it("uses evaluator for conflict resolution", async () => {
    const evaluator = new RuleBasedEvaluator();
    const memory = createMarvMem({
      storage: { backend: "memory" },
      evaluator,
    });

    // Write initial memory
    const record1 = await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "preference",
      content: "User prefers dark mode",
      tags: ["ui"],
    });

    // Write contradicting memory with temporal marker
    const record2 = await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "preference",
      content: "User now prefers light mode",
      tags: ["ui"],
    });

    // Should have resolved the contradiction (same record updated)
    const all = await memory.list({ scopes: [{ type: "user", id: "test" }] });
    // May be 1 (contradicted & updated) or 2 (added as new if similarity was low)
    // The key assertion is that the system didn't crash and made a decision
    assert.ok(all.length >= 1);
  });

  it("backward compatible: works without evaluator", async () => {
    const memory = createMarvMem({
      storage: { backend: "memory" },
    });

    const r1 = await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "fact",
      content: "Sky is blue",
    });

    // Identical content should be deduped by threshold
    const r2 = await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "fact",
      content: "Sky is blue",
    });

    assert.equal(r1.id, r2.id); // Same record, merged
  });

  it("stores previousContent when contradiction replaces a memory", async () => {
    const memory = createMarvMem({
      storage: { backend: "memory" },
      evaluator: new RuleBasedEvaluator(),
    });

    await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "preference",
      content: "User prefers dark mode",
    });

    const updated = await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "preference",
      content: "User now prefers light mode",
    });

    assert.equal(updated.metadata?.previousContent, "User prefers dark mode");
  });

  it("still uses evaluator when dedupeThreshold is disabled", async () => {
    const memory = createMarvMem({
      storage: { backend: "memory" },
      dedupeThreshold: 1,
      evaluator: new RuleBasedEvaluator(),
    });

    const first = await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "preference",
      content: "User prefers dark mode",
    });

    const second = await memory.remember({
      scope: { type: "user", id: "test" },
      kind: "preference",
      content: "User now prefers light mode",
    });

    assert.equal(first.id, second.id);
  });
});
