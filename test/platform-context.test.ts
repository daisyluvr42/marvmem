import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveContextScopes,
  canonicalTaskId,
  canonicalRepoId,
  filterScopesByTargets,
  recordBelongsToProject,
} from "../src/platform/context.js";

describe("canonicalTaskId", () => {
  it("returns undefined when taskId is missing", () => {
    assert.equal(canonicalTaskId({ projectId: "proj_1" }), undefined);
  });

  it("joins projectId, repoId, and taskId", () => {
    assert.equal(
      canonicalTaskId({ projectId: "proj_1", repoId: "repo_a", taskId: "t1" }),
      "proj_1::repo_a::t1",
    );
  });

  it("uses underscore placeholder when repoId is missing", () => {
    assert.equal(
      canonicalTaskId({ projectId: "proj_1", taskId: "t1" }),
      "proj_1::_::t1",
    );
  });
});

describe("canonicalRepoId", () => {
  it("returns undefined when repoId is missing", () => {
    assert.equal(canonicalRepoId({ projectId: "proj_1" }), undefined);
  });

  it("joins projectId and repoId", () => {
    assert.equal(
      canonicalRepoId({ projectId: "proj_1", repoId: "repo_a" }),
      "proj_1::repo_a",
    );
  });
});

describe("resolveContextScopes", () => {
  it("throws when projectId is missing", () => {
    assert.throws(
      () => resolveContextScopes({ projectId: "" }),
      /projectId is required/,
    );
  });

  it("returns project write scope when no repoId", () => {
    const result = resolveContextScopes({ projectId: "proj_1" });
    assert.deepStrictEqual(result.writeScope, { type: "project", id: "proj_1" });
  });

  it("returns repo write scope when repoId is present", () => {
    const result = resolveContextScopes({ projectId: "proj_1", repoId: "repo_a" });
    assert.deepStrictEqual(result.writeScope, { type: "repo", id: "proj_1::repo_a" });
  });

  it("returns only project recall scope for minimal context", () => {
    const result = resolveContextScopes({ projectId: "proj_1" });
    assert.equal(result.recallScopes.length, 1);
    assert.equal(result.recallScopes[0]!.type, "project");
    assert.equal(result.recallScopes[0]!.id, "proj_1");
    assert.equal(result.recallScopes[0]!.weight, 1.08);
  });

  it("returns correct recall scope order for full context", () => {
    const result = resolveContextScopes({
      projectId: "proj_1",
      repoId: "repo_a",
      userId: "user_d",
      agentId: "codex",
      sessionId: "sess_1",
      taskId: "task_r",
    });

    const types = result.recallScopes.map((s) => s.type);
    assert.deepStrictEqual(types, ["task", "repo", "project", "user", "agent", "session"]);
  });

  it("assigns descending weights", () => {
    const result = resolveContextScopes({
      projectId: "proj_1",
      repoId: "repo_a",
      userId: "user_d",
      agentId: "codex",
      sessionId: "sess_1",
      taskId: "task_r",
    });

    const weights = result.recallScopes.map((s) => s.weight!);
    for (let i = 1; i < weights.length; i++) {
      assert.ok(
        weights[i]! <= weights[i - 1]!,
        `weight at index ${i} (${weights[i]}) should be <= weight at index ${i - 1} (${weights[i - 1]})`,
      );
    }
  });

  it("uses canonical task id in recall scopes", () => {
    const result = resolveContextScopes({
      projectId: "proj_1",
      repoId: "repo_a",
      taskId: "t1",
    });
    const taskScope = result.recallScopes.find((s) => s.type === "task");
    assert.ok(taskScope);
    assert.equal(taskScope.id, "proj_1::repo_a::t1");
  });

  it("omits optional scopes when fields are absent", () => {
    const result = resolveContextScopes({ projectId: "proj_1", repoId: "repo_a" });
    const types = result.recallScopes.map((s) => s.type);
    assert.deepStrictEqual(types, ["repo", "project"]);
    assert.ok(!types.includes("task"));
    assert.ok(!types.includes("user"));
    assert.ok(!types.includes("agent"));
    assert.ok(!types.includes("session"));
  });

  it("adds multiple agent scopes without changing the write scope", () => {
    const result = resolveContextScopes({
      projectId: "proj_1",
      agentId: "codex",
      agentIds: ["claude", "codex"],
    });
    assert.deepStrictEqual(result.writeScope, { type: "project", id: "proj_1" });
    assert.deepStrictEqual(
      result.recallScopes.filter((scope) => scope.type === "agent").map((scope) => scope.id),
      ["codex", "claude"],
    );
  });
});

describe("filterScopesByTargets", () => {
  const ctx = {
    projectId: "proj_1",
    repoId: "repo_a",
    userId: "user_d",
    agentId: "codex",
  };

  it("returns full recall scopes when targets is empty", () => {
    const scopes = filterScopesByTargets(ctx);
    assert.equal(scopes.length, 4);
  });

  it("filters by target types", () => {
    const scopes = filterScopesByTargets(ctx, ["repo", "user"]);
    const types = scopes.map((s) => s.type);
    assert.deepStrictEqual(types, ["repo", "user"]);
  });

  it("returns empty when target does not match", () => {
    const scopes = filterScopesByTargets(ctx, ["task"]);
    assert.equal(scopes.length, 0);
  });
});

describe("recordBelongsToProject", () => {
  const ctx = {
    projectId: "proj_1",
    repoId: "repo_a",
    userId: "user_d",
  };

  it("returns true for a matching repo scope", () => {
    assert.ok(recordBelongsToProject({ scope: { type: "repo", id: "proj_1::repo_a" } }, ctx));
  });

  it("returns true for a matching project scope", () => {
    assert.ok(recordBelongsToProject({ scope: { type: "project", id: "proj_1" } }, ctx));
  });

  it("returns true for a matching user scope", () => {
    assert.ok(recordBelongsToProject({ scope: { type: "user", id: "user_d" } }, ctx));
  });

  it("returns false for a different project", () => {
    assert.ok(!recordBelongsToProject({ scope: { type: "project", id: "proj_other" } }, ctx));
  });

  it("returns false for a different repo", () => {
    assert.ok(!recordBelongsToProject({ scope: { type: "repo", id: "repo_other" } }, ctx));
  });

  it("is case-insensitive", () => {
    assert.ok(recordBelongsToProject({ scope: { type: "repo", id: "Proj_1::Repo_A" } }, ctx));
  });

  it("can include explicitly shared agent scopes", () => {
    const sharedCtx = { ...ctx, agentIds: ["codex", "claude"] };
    assert.ok(recordBelongsToProject({ scope: { type: "agent", id: "claude" } }, sharedCtx));
    assert.ok(!recordBelongsToProject({ scope: { type: "agent", id: "antigravity" } }, sharedCtx));
  });
});
