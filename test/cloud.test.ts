import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { InMemoryUsageMeter, currentBillingPeriod } from "../src/cloud/usage.js";
import { PlanGate } from "../src/cloud/gate.js";
import {
  CloudSyncManager,
  InMemorySyncTarget,
  InMemoryLocalSyncStore,
  MemoryStoreLocalSyncStore,
} from "../src/cloud/sync.js";
import { InMemoryAuthProvider, decodeJwtPayload, isJwtExpired } from "../src/cloud/auth.js";
import { PLAN_LIMITS } from "../src/cloud/types.js";
import type { CloudMemoryRecord } from "../src/cloud/types.js";
import { InMemoryStore } from "../src/core/storage.js";

// ---------------------------------------------------------------------------
// UsageMeter
// ---------------------------------------------------------------------------

describe("InMemoryUsageMeter", () => {
  it("starts at zero", async () => {
    const meter = new InMemoryUsageMeter();
    const usage = await meter.getUsage("proj_1");
    assert.equal(usage.memoriesWritten, 0);
    assert.equal(usage.memoriesTotal, 0);
    assert.equal(usage.embeddingsCount, 0);
  });

  it("increments counters", async () => {
    const meter = new InMemoryUsageMeter();
    await meter.increment("proj_1", "memoriesWritten");
    await meter.increment("proj_1", "memoriesWritten", 5);
    const usage = await meter.getUsage("proj_1");
    assert.equal(usage.memoriesWritten, 6);
  });

  it("isolates projects", async () => {
    const meter = new InMemoryUsageMeter();
    await meter.increment("proj_1", "memoriesWritten", 3);
    await meter.increment("proj_2", "memoriesWritten", 7);
    assert.equal((await meter.getUsage("proj_1")).memoriesWritten, 3);
    assert.equal((await meter.getUsage("proj_2")).memoriesWritten, 7);
  });

  it("checks quota against plan limits", async () => {
    const meter = new InMemoryUsageMeter();
    // Free: 500 memoriesPerPeriod
    const result = await meter.checkQuota("proj_1", "free", "memoriesWritten");
    assert.equal(result.allowed, true);
    assert.equal(result.limit, 500);

    // Exhaust quota
    await meter.increment("proj_1", "memoriesWritten", 500);
    const result2 = await meter.checkQuota("proj_1", "free", "memoriesWritten");
    assert.equal(result2.allowed, false);
    assert.equal(result2.current, 500);
  });

  it("pro plan allows more", async () => {
    const meter = new InMemoryUsageMeter();
    await meter.increment("proj_1", "memoriesWritten", 500);
    const result = await meter.checkQuota("proj_1", "pro", "memoriesWritten");
    assert.equal(result.allowed, true);
    assert.equal(result.limit, 5000);
  });

  it("resets period", async () => {
    const meter = new InMemoryUsageMeter();
    await meter.increment("proj_1", "memoriesWritten", 10);
    await meter.resetPeriod("proj_1", currentBillingPeriod());
    const usage = await meter.getUsage("proj_1");
    assert.equal(usage.memoriesWritten, 0);
  });
});

// ---------------------------------------------------------------------------
// PlanGate
// ---------------------------------------------------------------------------

describe("PlanGate", () => {
  it("allows writes under quota", async () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    const result = await gate.check("proj_1", "free", "write_memory");
    assert.equal(result.allowed, true);
  });

  it("blocks writes over quota", async () => {
    const meter = new InMemoryUsageMeter();
    await meter.increment("proj_1", "memoriesWritten", 500);
    const gate = new PlanGate(meter);
    const result = await gate.check("proj_1", "free", "write_memory");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("quota exceeded"));
  });

  it("blocks cloud_sync on free", async () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    const result = await gate.check("proj_1", "free", "cloud_sync");
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes("Pro"));
  });

  it("allows cloud_sync on pro", async () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    const result = await gate.check("proj_1", "pro", "cloud_sync");
    assert.equal(result.allowed, true);
  });

  it("blocks multi_agent on free (1 agent limit)", async () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    const result = await gate.check("proj_1", "free", "multi_agent", {
      agentCount: 1,
    });
    assert.equal(result.allowed, false);
  });

  it("allows multi_agent on pro", async () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    const result = await gate.check("proj_1", "pro", "multi_agent", {
      agentCount: 3,
    });
    assert.equal(result.allowed, true);
  });

  it("assert throws on denied", async () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    await assert.rejects(
      () => gate.assert("proj_1", "free", "cloud_sync"),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "PLAN_LIMIT_EXCEEDED");
        return true;
      },
    );
  });

  it("blocks rbac on pro (requires team)", async () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    assert.equal(
      (await gate.check("proj_1", "pro", "rbac")).allowed,
      false,
    );
    assert.equal(
      (await gate.check("proj_1", "team", "rbac")).allowed,
      true,
    );
  });

  it("getFeatureMatrix returns correct flags", () => {
    const meter = new InMemoryUsageMeter();
    const gate = new PlanGate(meter);
    const free = gate.getFeatureMatrix("free");
    assert.equal(free.write_memory, true);
    assert.equal(free.cloud_sync, false);
    assert.equal(free.multi_agent, false);

    const pro = gate.getFeatureMatrix("pro");
    assert.equal(pro.cloud_sync, true);
    assert.equal(pro.multi_agent, true);
    assert.equal(pro.rbac, false);

    const team = gate.getFeatureMatrix("team");
    assert.equal(team.rbac, true);
    assert.equal(team.team_dashboard, true);
  });
});

// ---------------------------------------------------------------------------
// CloudSyncManager
// ---------------------------------------------------------------------------

function mockRecord(overrides: Partial<CloudMemoryRecord> = {}): CloudMemoryRecord {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 8)}`,
    projectId: "proj_1",
    scopeType: "project",
    scopeId: "proj_1",
    kind: "fact",
    content: "test content",
    confidence: 0.7,
    importance: 0.5,
    source: "test",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    syncVersion: 0,
    ...overrides,
  };
}

describe("CloudSyncManager", () => {
  it("pushes unsynced records to remote", async () => {
    const local = new InMemoryLocalSyncStore();
    const remote = new InMemorySyncTarget();
    const sync = new CloudSyncManager(local, remote);

    const r1 = mockRecord({ id: "m1" });
    const r2 = mockRecord({ id: "m2" });
    local.addRecord(r1);
    local.addRecord(r2);

    const result = await sync.push("proj_1");
    assert.equal(result.direction, "push");
    assert.equal(result.recordsProcessed, 2);
    assert.equal(result.errors.length, 0);

    // Records should be in remote
    assert.equal(remote.getAll().length, 2);
    // Local should be marked synced
    assert.ok(local.getRecord("m1")!.syncVersion > 0);
  });

  it("pulls remote records to local", async () => {
    const local = new InMemoryLocalSyncStore();
    const remote = new InMemorySyncTarget();
    const sync = new CloudSyncManager(local, remote);

    // Push remote records directly
    await remote.push([
      mockRecord({ id: "r1", content: "remote content" }),
    ]);

    const result = await sync.pull("proj_1");
    assert.equal(result.direction, "pull");
    assert.equal(result.recordsProcessed, 1);
    assert.equal(local.getRecord("r1")?.content, "remote content");
  });

  it("full sync: pull then push", async () => {
    const local = new InMemoryLocalSyncStore();
    const remote = new InMemorySyncTarget();
    const sync = new CloudSyncManager(local, remote);

    // Local has unsynced records
    local.addRecord(mockRecord({ id: "local1" }));
    // Remote has different records
    await remote.push([
      mockRecord({ id: "remote1", content: "from cloud" }),
    ]);

    const result = await sync.sync("proj_1");
    assert.equal(result.pull.recordsProcessed, 1);
    assert.equal(result.push.recordsProcessed, 1);

    // Both should be in remote now
    assert.equal(remote.getAll().length, 2);
    // Remote record should be in local
    assert.ok(local.getRecord("remote1"));
  });

  it("noop push when nothing to sync", async () => {
    const local = new InMemoryLocalSyncStore();
    const remote = new InMemorySyncTarget();
    const sync = new CloudSyncManager(local, remote);

    const result = await sync.push("proj_1");
    assert.equal(result.recordsProcessed, 0);
  });

  it("updates sync state", async () => {
    const local = new InMemoryLocalSyncStore();
    const remote = new InMemorySyncTarget();
    const sync = new CloudSyncManager(local, remote);

    local.addRecord(mockRecord({ id: "m1" }));
    await sync.push("proj_1");

    const state = await sync.getState("proj_1");
    assert.ok(state.lastSyncAt);
    assert.ok(state.lastSyncVersion > 0);
  });

  it("incremental pull uses lastSyncVersion", async () => {
    const local = new InMemoryLocalSyncStore();
    const remote = new InMemorySyncTarget();
    const sync = new CloudSyncManager(local, remote);

    // First batch
    await remote.push([mockRecord({ id: "r1" })]);
    await sync.pull("proj_1");

    // Second batch
    await remote.push([mockRecord({ id: "r2" })]);
    const result = await sync.pull("proj_1");

    // Should only pull the new record
    assert.equal(result.recordsProcessed, 1);
  });

  it("can sync records from a MemoryStore", async () => {
    const store = new InMemoryStore();
    await store.save([
      {
        id: "m1",
        scope: { type: "project", id: "proj_1" },
        kind: "fact",
        content: "Local memory.",
        summary: "Local memory.",
        confidence: 0.8,
        importance: 0.7,
        source: "test",
        tags: [],
        metadata: { projectId: "proj_1" },
        createdAt: "2026-04-24T00:00:00.000Z",
        updatedAt: "2026-04-24T00:00:00.000Z",
      },
    ]);
    const local = new MemoryStoreLocalSyncStore(store);
    const remote = new InMemorySyncTarget();
    const sync = new CloudSyncManager(local, remote);

    const result = await sync.push("proj_1");
    assert.equal(result.recordsProcessed, 1);
    assert.equal(remote.getAll()[0]!.content, "Local memory.");
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("InMemoryAuthProvider", () => {
  it("validates registered tokens", async () => {
    const auth = new InMemoryAuthProvider();
    auth.register("tok_123", {
      id: "user_1",
      email: "test@example.com",
      plan: "pro",
      projectIds: ["proj_1"],
    });

    const user = await auth.validateToken("tok_123");
    assert.ok(user);
    assert.equal(user.id, "user_1");
    assert.equal(user.plan, "pro");
  });

  it("rejects unknown tokens", async () => {
    const auth = new InMemoryAuthProvider();
    const user = await auth.validateToken("invalid");
    assert.equal(user, null);
  });

  it("checks project access", async () => {
    const auth = new InMemoryAuthProvider();
    auth.register("tok_1", {
      id: "user_1",
      email: "test@example.com",
      plan: "team",
      projectIds: [],
    });
    auth.grantAccess("user_1", "proj_1", "editor");

    const access = await auth.checkProjectAccess("user_1", "proj_1");
    assert.equal(access.allowed, true);
    assert.equal(access.role, "editor");

    const noAccess = await auth.checkProjectAccess("user_1", "proj_2");
    assert.equal(noAccess.allowed, false);
  });

  it("getUserPlan returns plan", async () => {
    const auth = new InMemoryAuthProvider();
    auth.register("tok_1", {
      id: "user_1",
      email: "test@example.com",
      plan: "team",
      projectIds: [],
    });

    assert.equal(await auth.getUserPlan("user_1"), "team");
    assert.equal(await auth.getUserPlan("unknown"), "free");
  });
});

describe("JWT helpers", () => {
  it("decodes JWT payload", () => {
    // Build a minimal JWT: header.payload.signature
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "user_1", exp: 9999999999 })).toString("base64url");
    const token = `${header}.${payload}.fake_sig`;

    const decoded = decodeJwtPayload(token);
    assert.ok(decoded);
    assert.equal(decoded.sub, "user_1");
  });

  it("detects expired JWT", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url");
    const token = `${header}.${payload}.sig`;

    assert.equal(isJwtExpired(token), true);
  });

  it("detects valid JWT", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString("base64url");
    const token = `${header}.${payload}.sig`;

    assert.equal(isJwtExpired(token), false);
  });
});

// ---------------------------------------------------------------------------
// Plan Limits sanity
// ---------------------------------------------------------------------------

describe("PLAN_LIMITS", () => {
  it("free is most restrictive", () => {
    assert.equal(PLAN_LIMITS.free.memoriesPerPeriod, 500);
    assert.equal(PLAN_LIMITS.free.maxAgents, 1);
    assert.equal(PLAN_LIMITS.free.syncEnabled, false);
  });

  it("pro unlocks sync and multi-agent", () => {
    assert.equal(PLAN_LIMITS.pro.syncEnabled, true);
    assert.equal(PLAN_LIMITS.pro.maxAgents, 10);
    assert.equal(PLAN_LIMITS.pro.memoriesPerPeriod, 5000);
  });

  it("team unlocks rbac and dashboard", () => {
    assert.equal(PLAN_LIMITS.team.rbac, true);
    assert.equal(PLAN_LIMITS.team.teamDashboard, true);
    assert.equal(PLAN_LIMITS.team.maxSeats, 50);
  });

  it("enterprise is unlimited", () => {
    assert.equal(PLAN_LIMITS.enterprise.memoriesPerPeriod, Infinity);
    assert.equal(PLAN_LIMITS.enterprise.maxAgents, Infinity);
  });
});
