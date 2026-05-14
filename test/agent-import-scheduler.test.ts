import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startAgentImportScheduler } from "../src/agents/import-scheduler.js";

test("agent import scheduler skips overlapping runs", async () => {
  let active = 0;
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scheduler = startAgentImportScheduler({
    agentOptions: {
      home: tmpdir(),
      storagePath: join(tmpdir(), "marvmem-scheduler-test.sqlite"),
      mcpPath: join(tmpdir(), "marvmem-mcp.js"),
    },
    agents: ["codex"],
    intervalMs: 60_000,
    importOne: async () => {
      calls += 1;
      active += 1;
      assert.equal(active, 1);
      await gate;
      active -= 1;
    },
  });

  try {
    const first = scheduler.runOnce();
    await delay(5);
    const second = await scheduler.runOnce();
    assert.equal(second, false);
    assert.equal(calls, 1);
    release();
    assert.equal(await first, true);
  } finally {
    scheduler.stop();
    release();
  }
});
