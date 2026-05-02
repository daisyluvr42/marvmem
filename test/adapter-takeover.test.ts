import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHermesMemoryWrite,
  createHermesAgentMemoryAdapter,
  createMarvInferencer,
  createOpenClawInferencer,
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
  const userPath = join(workspacePath, "USER.md");
  const dreamsPath = join(workspacePath, "DREAMS.md");
  const todayFile = join(dailyDir, "2026-04-19.md");

  try {
    await mkdir(dailyDir, { recursive: true });
    await writeFile(memoryPath, "- Use pnpm workspaces.\n", "utf8");
    await writeFile(userPath, "- Prefers concise release notes.\n", "utf8");
    await writeFile(todayFile, "Follow up on the release checklist.\n", "utf8");
    await writeFile(dreamsPath, "- Consolidate recurring release lessons.\n", "utf8");

    const memory = createMarvMem({
      store: new InMemoryStore(),
      inferencer: async ({ prompt }) => ({ ok: true, text: `Summary: ${prompt}` }),
    });

    const { adapter, imported } = await installOpenClawMemoryTakeover({
      memory,
      defaultScopes: [{ type: "agent", id: "openclaw-test" }],
      files: { workspacePath, memoryPath, userPath, dailyDir, dreamsPath },
      now: () => new Date("2026-04-19T10:00:00Z"),
    });

    assert.equal(imported.memoryEntries, 1);
    assert.equal(imported.userEntries, 1);
    assert.equal(imported.dailyEntries, 1);
    assert.equal(imported.dreamEntries, 1);

    await adapter.afterTurn({
      taskTitle: "Release checklist",
      userMessage: "Remember that we use pnpm workspaces for all packages, and I prefer concise release notes.",
      assistantMessage: "I will keep using pnpm workspaces.",
      toolContext: "Touched files: package.json, pnpm-lock.yaml",
    });

    let nextMemory = await readFile(memoryPath, "utf8");
    const nextUser = await readFile(userPath, "utf8");
    let nextDaily = await readFile(todayFile, "utf8");
    const nextDreams = await readFile(dreamsPath, "utf8");

    assert.match(nextMemory, /Use pnpm workspaces/);
    assert.match(nextUser, /concise release notes/);
    assert.match(nextDaily, /Follow up on the release checklist/);
    assert.match(nextDaily, /Task: Release checklist/);
    assert.match(nextDaily, /Touched files: package\.json, pnpm-lock\.yaml/);
    assert.match(nextDreams, /Consolidate recurring release lessons/);

    await adapter.flushSession();

    nextDaily = await readFile(todayFile, "utf8");
    nextMemory = await readFile(memoryPath, "utf8");

    assert.match(nextDaily, /user: Remember that we use pnpm workspaces for all packages, and I prefer concise release notes\./);
    assert.match(nextMemory, /we use pnpm workspaces for all packages, and I prefer concise release notes\./);
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

test("OpenClaw flush-session CLI distills active context from forwarded session messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-openclaw-cli-"));
  const workspacePath = join(root, ".openclaw", "workspace");
  const dailyDir = join(workspacePath, "memory");
  const storagePath = join(root, ".openclaw", "marvmem.sqlite");
  const scope = { type: "agent", id: "openclaw-cli" } as const;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "CLI active summary." } }],
        }),
      );
    });
  });

  try {
    await mkdir(dailyDir, { recursive: true });
    await writeFile(join(workspacePath, "MEMORY.md"), "- Use uv for Python projects.\n", "utf8");
    await writeFile(join(workspacePath, "USER.md"), "- Prefers concise Chinese replies.\n", "utf8");

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-openclaw.ts"),
      "flush-session",
      "--openclaw-home",
      root,
      "--storage-path",
      storagePath,
      "--scope-type",
      scope.type,
      "--scope-id",
      scope.id,
      "--recent-message",
      "user: Remember that I prefer numbered lists.",
      "--recent-message",
      "assistant: I will keep replies structured.",
      "--inferencer",
      JSON.stringify({
        api: "openai-completions",
        model: "test-model",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "test-key",
        authHeader: true,
      }),
    ]);

    const memory = createMarvMem({ storagePath });
    const activeContext = await memory.active.read("context", scope);

    assert.equal(activeContext?.content, "CLI active summary.");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw inferencer can reuse an OpenAI-compatible runtime model", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Concise active summary." } }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const inferencer = createOpenClawInferencer({
      api: "openai-completions",
      model: "gpt-4.1-mini",
      baseUrl: "http://127.0.0.1:4040",
      apiKey: "test-key",
      headers: { "x-openclaw-provider": "runtime" },
    });

    const result = await inferencer({
      kind: "context",
      system: "Summarize the session.",
      prompt: "The user prefers concise Chinese replies.",
      maxChars: 320,
    });

    assert.deepEqual(result, { ok: true, text: "Concise active summary." });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:4040/v1/chat/completions");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer test-key");
    assert.equal(calls[0]?.headers.get("x-openclaw-provider"), "runtime");
    assert.match(calls[0]?.body ?? "", /gpt-4\.1-mini/);
    assert.match(calls[0]?.body ?? "", /Summarize the session/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenClaw inferencer honors runtime auth overrides", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ headers: Headers; url: string }> = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      headers: new Headers(init?.headers),
    });
    return new Response(
      JSON.stringify({
        output_text: "Task summary from runtime auth.",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const inferencer = createOpenClawInferencer({
      api: "openai-responses",
      model: "gpt-5-mini",
      baseUrl: "https://runtime.example.com/v1",
      request: {
        auth: {
          mode: "header",
          headerName: "x-runtime-token",
          value: "runtime-secret",
          prefix: "Bearer",
        },
      },
    });

    const result = await inferencer({
      kind: "task_summary",
      system: "Summarize the task state.",
      prompt: "Recent task entries go here.",
      maxChars: 480,
    });

    assert.deepEqual(result, { ok: true, text: "Task summary from runtime auth." });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://runtime.example.com/v1/responses");
    assert.equal(calls[0]?.headers.get("x-runtime-token"), "Bearer runtime-secret");
    assert.equal(calls[0]?.headers.get("authorization"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Marv adapter exposes the API-backed inferencer helper", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      calls.push(init.body);
    }
    return new Response(
      JSON.stringify({
        output_text: "Marv runtime summary.",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const inferencer = createMarvInferencer({
      api: "openai-responses",
      model: "gpt-5-mini",
      baseUrl: "http://127.0.0.1:4040",
      apiKey: "test-key",
    });

    const result = await inferencer({
      kind: "context",
      system: "Summarize the current Marv session.",
      prompt: "Marv has provider config and can call the API directly.",
      maxChars: 320,
    });

    assert.deepEqual(result, { ok: true, text: "Marv runtime summary." });
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /gpt-5-mini/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("OpenClaw install-plugin writes async bridge calls into the generated plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-openclaw-plugin-"));
  const workspacePath = join(root, ".openclaw", "workspace");
  const dailyDir = join(workspacePath, "memory");

  try {
    await mkdir(dailyDir, { recursive: true });
    await writeFile(join(workspacePath, "MEMORY.md"), "", "utf8");
    await writeFile(join(workspacePath, "USER.md"), "", "utf8");

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-openclaw.ts"),
      "install-plugin",
      "--openclaw-home",
      root,
      "--storage-path",
      join(root, ".openclaw", "marvmem.sqlite"),
    ]);

    const pluginSource = await readFile(join(root, ".openclaw", "plugins", "marvmem", "index.mjs"), "utf8");

    assert.match(pluginSource, /import \{ execFile \} from "node:child_process"/);
    assert.doesNotMatch(pluginSource, /execFileSync/);
    assert.match(pluginSource, /const result = await runJson\("before-prompt", args\)/);
    assert.match(pluginSource, /void runVoid\("after-turn"/);
    assert.match(pluginSource, /void runVoid\("flush-session", args\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hermes install-plugin keeps bridge stderr visible in the generated plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-hermes-plugin-"));
  const memoriesDir = join(root, "memories");

  try {
    await mkdir(memoriesDir, { recursive: true });
    await writeFile(join(memoriesDir, "MEMORY.md"), "", "utf8");
    await writeFile(join(memoriesDir, "USER.md"), "", "utf8");

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-hermes.ts"),
      "install-plugin",
      "--hermes-home",
      root,
      "--storage-path",
      join(root, "marvmem.sqlite"),
      "--inferencer",
      JSON.stringify({
        api: "openai-completions",
        model: "gpt-4.1-mini",
        baseUrl: "http://127.0.0.1:4141",
        apiKey: "test-key",
      }),
    ]);

    const pluginSource = await readFile(join(root, "plugins", "marvmem", "__init__.py"), "utf8");

    assert.match(pluginSource, /import os/);
    assert.match(pluginSource, /MARVMEM_INFERENCER/);
    assert.match(pluginSource, /--inferencer/);
    assert.match(pluginSource, /RECENT_MESSAGES_BY_SESSION/);
    assert.match(pluginSource, /--recent-message/);
    assert.match(pluginSource, /stderr=subprocess\.PIPE/);
    assert.match(pluginSource, /text=True/);
    assert.match(pluginSource, /if completed\.returncode != 0:/);
    assert.match(pluginSource, /logger\.warning\("marvmem bridge exited with status %s: %s"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Hermes flush-session can use an API-backed inferencer", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-hermes-inferencer-"));
  const memoriesDir = join(root, "memories");
  const storagePath = join(root, "marvmem.sqlite");
  const requests: string[] = [];
  let listening = false;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Hermes distilled summary." } }] }));
    });
  });

  try {
    await mkdir(memoriesDir, { recursive: true });
    await writeFile(join(memoriesDir, "MEMORY.md"), "", "utf8");
    await writeFile(join(memoriesDir, "USER.md"), "", "utf8");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    listening = true;
    const address = server.address();
    assert(address && typeof address === "object");

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-hermes.ts"),
      "flush-session",
      "--hermes-home",
      root,
      "--storage-path",
      storagePath,
      "--inferencer",
      JSON.stringify({
        api: "openai-completions",
        model: "gpt-4.1-mini",
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key",
      }),
      "--recent-message",
      "user: Please remember the deployment boundary.",
      "--recent-message",
      "assistant: We aligned Hermes to API-backed distill.",
    ]);

    assert.equal(requests.length, 1);
    assert.match(requests[0] ?? "", /deployment boundary/);

    const memory = createMarvMem({ storagePath });
    const context = await memory.active.read("context", { type: "agent", id: "hermes" });
    assert.equal(context?.content, "Hermes distilled summary.");
  } finally {
    if (listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}
