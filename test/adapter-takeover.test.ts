import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHermesMemoryWrite,
  createHermesAgentMemoryAdapter,
  createOpenClawMemoryAdapter,
  installHermesAgentMemoryTakeover,
  installOpenClawMemoryTakeover,
} from "../src/adapters/index.js";
import { createMarvMem, InMemoryStore } from "../src/core/index.js";

test("Hermes takeover imports MEMORY.md and USER.md, then rewrites them from MarvMem", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-hermes-"));
  const memoryPath = join(root, "MEMORY.md");
  const userPath = join(root, "USER.md");

  try {
    await writeFile(memoryPath, "- Use uv for Python projects.\n- Keep commits focused.\n", "utf8");
    await writeFile(userPath, "- Prefers concise Chinese replies.\n", "utf8");

    const memory = createMarvMem({
      store: new InMemoryStore(),
      inferencer: async ({ prompt }) => ({ ok: true, text: prompt }),
    });

    const { adapter, imported } = await installHermesAgentMemoryTakeover({
      memory,
      defaultScopes: [{ type: "agent", id: "hermes-test" }],
      files: { memoryPath, userPath },
    });

    assert.equal(imported.memoryEntries, 2);
    assert.equal(imported.userEntries, 1);

    await adapter.afterTurn({
      userMessage: "Remember that I prefer bullet points and concise Chinese replies.",
      assistantMessage: "I will keep responses short and structured.",
    });

    const nextMemory = await readFile(memoryPath, "utf8");
    const nextUser = await readFile(userPath, "utf8");

    assert.match(nextMemory, /Use uv for Python projects/);
    assert.match(nextMemory, /Keep commits focused/);
    assert.match(nextUser, /bullet points/);
    assert.match(nextUser, /concise Chinese replies/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw takeover imports workspace markdown and keeps projections updated", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-openclaw-"));
  const workspacePath = join(root, "workspace");
  const dailyDir = join(workspacePath, "memory");
  const memoryPath = join(workspacePath, "MEMORY.md");
  const dreamsPath = join(workspacePath, "DREAMS.md");
  const todayFile = join(dailyDir, "2026-04-19.md");

  try {
    await mkdir(dailyDir, { recursive: true });
    await writeFile(memoryPath, "- Use pnpm workspaces.\n", "utf8");
    await writeFile(todayFile, "Follow up on the release checklist.\n", "utf8");
    await writeFile(dreamsPath, "- Consolidate recurring release lessons.\n", "utf8");

    const memory = createMarvMem({
      store: new InMemoryStore(),
      inferencer: async ({ prompt }) => ({ ok: true, text: `Summary: ${prompt}` }),
    });

    const { adapter, imported } = await installOpenClawMemoryTakeover({
      memory,
      defaultScopes: [{ type: "agent", id: "openclaw-test" }],
      files: { workspacePath, memoryPath, dailyDir, dreamsPath },
      now: () => new Date("2026-04-19T10:00:00Z"),
    });

    assert.equal(imported.memoryEntries, 1);
    assert.equal(imported.dailyEntries, 1);
    assert.equal(imported.dreamEntries, 1);

    await adapter.afterTurn({
      taskTitle: "Release checklist",
      userMessage: "Remember that we use pnpm workspaces for all packages.",
      assistantMessage: "I will keep using pnpm workspaces.",
      toolContext: "Touched files: package.json, pnpm-lock.yaml",
    });

    let nextMemory = await readFile(memoryPath, "utf8");
    let nextDaily = await readFile(todayFile, "utf8");
    const nextDreams = await readFile(dreamsPath, "utf8");

    assert.match(nextMemory, /Use pnpm workspaces/);
    assert.match(nextDaily, /Follow up on the release checklist/);
    assert.match(nextDaily, /Task: Release checklist/);
    assert.match(nextDaily, /Touched files: package\.json, pnpm-lock\.yaml/);
    assert.match(nextDreams, /Consolidate recurring release lessons/);

    await adapter.flushSession();

    nextDaily = await readFile(todayFile, "utf8");
    nextMemory = await readFile(memoryPath, "utf8");

    assert.match(nextDaily, /user: Remember that we use pnpm workspaces for all packages\./);
    assert.match(nextMemory, /we use pnpm workspaces for all packages\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent-specific adapter factories default to takeover-friendly session scopes", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const hermes = createHermesAgentMemoryAdapter({ memory });
  const openclaw = createOpenClawMemoryAdapter({ memory });

  const hermesPrompt = await hermes.beforePrompt({ userMessage: "hi" });
  const openclawPrompt = await openclaw.beforePrompt({ userMessage: "hi" });

  assert.equal(typeof hermesPrompt.systemHint, "string");
  assert.equal(typeof openclawPrompt.systemHint, "string");
});

test("Hermes memory writes can be mirrored into MarvMem records", async () => {
  const memory = createMarvMem({ store: new InMemoryStore() });
  const scope = { type: "agent", id: "hermes-tool" } as const;

  await applyHermesMemoryWrite({
    memory,
    scopes: [scope],
    action: "add",
    target: "user",
    content: "Prefers concise answers.",
  });

  let records = await memory.list({ scopes: [scope] });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.summary, "Prefers concise answers.");
  assert.equal(records[0]?.metadata?.projectionTarget, "user");

  await applyHermesMemoryWrite({
    memory,
    scopes: [scope],
    action: "replace",
    target: "user",
    oldText: "concise",
    content: "Prefers concise Chinese answers with bullet points.",
  });

  records = await memory.list({ scopes: [scope] });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.summary, "Prefers concise Chinese answers with bullet points.");

  await applyHermesMemoryWrite({
    memory,
    scopes: [scope],
    action: "remove",
    target: "user",
    oldText: "bullet points",
  });

  records = await memory.list({ scopes: [scope] });
  assert.equal(records.length, 0);
});
