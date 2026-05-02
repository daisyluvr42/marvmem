import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("agent installer writes global Codex MCP config and instruction block", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-agent-codex-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "marvmem-mcp.js");

  try {
    await runInstaller("codex", root, storagePath, mcpPath, "--skip-import");
    await runInstaller("codex", root, storagePath, mcpPath, "--skip-import");

    const config = await readFile(join(root, ".codex", "config.toml"), "utf8");
    assert.equal(config.match(/\[mcp_servers\.marvmem\]/g)?.length, 1);
    assert.match(config, new RegExp(escapeRegExp(`args = ["${mcpPath}"]`)));
    assert.match(config, /MARVMEM_STORAGE_PATH/);
    assert.doesNotMatch(config, /MARVMEM_SCOPE_ID/);

    const instructions = await readFile(join(root, ".codex", "AGENTS.md"), "utf8");
    assert.equal(instructions.match(/marvmem-agent-instructions:start/g)?.length, 1);
    assert.match(instructions, /omit scope first/);
    assert.match(instructions, /agent:codex/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent installer writes Cursor, Copilot, and Antigravity MCP configs and instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-agent-json-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "marvmem-mcp.js");

  try {
    await runInstaller("cursor", root, storagePath, mcpPath, "--skip-import");
    await runInstaller("copilot", root, storagePath, mcpPath, "--skip-import");
    await runInstaller("antigravity", root, storagePath, mcpPath, "--skip-import");

    const cursor = JSON.parse(await readFile(join(root, ".cursor", "mcp.json"), "utf8"));
    assert.equal(cursor.mcpServers.marvmem.command, "node");
    assert.deepEqual(cursor.mcpServers.marvmem.args, [mcpPath]);
    assert.equal(cursor.mcpServers.marvmem.env.MARVMEM_STORAGE_PATH, storagePath);

    const copilot = JSON.parse(await readFile(join(root, ".copilot", "mcp-config.json"), "utf8"));
    assert.equal(copilot.mcpServers.marvmem.type, "local");
    assert.deepEqual(copilot.mcpServers.marvmem.tools, ["*"]);

    const antigravity = JSON.parse(await readFile(join(root, ".gemini", "antigravity", "mcp_config.json"), "utf8"));
    assert.equal(antigravity.mcpServers.marvmem.command, "node");
    assert.deepEqual(antigravity.mcpServers.marvmem.args, [mcpPath]);
    assert.equal(antigravity.mcpServers.marvmem.env.MARVMEM_STORAGE_PATH, storagePath);

    const instructions = await readFile(join(root, ".copilot", "copilot-instructions.md"), "utf8");
    assert.match(instructions, /agent:copilot/);

    const cursorRule = await readFile(join(root, ".cursor", "rules", "marvmem.mdc"), "utf8");
    assert.match(cursorRule, /alwaysApply: true/);
    assert.match(cursorRule, /agent:cursor/);
    assert.match(cursorRule, /memory_session_commit/);

    const antigravityRules = await readFile(join(root, ".gemini", "GEMINI.md"), "utf8");
    assert.match(antigravityRules, /agent:antigravity/);
    assert.match(antigravityRules, /memory_session_commit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent installer import step tolerates missing session roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-agent-import-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "marvmem-mcp.js");

  try {
    const output = await runInstaller("codex", root, storagePath, mcpPath, "--skip-mcp", "--skip-instructions");
    const parsed = JSON.parse(output);
    assert.equal(parsed.results[0].import, "imported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent TUI once mode prints setup status", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-agent-tui-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "marvmem-mcp.js");

  try {
    const output = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-agent.ts"),
      "tui",
      "--once",
      "--home",
      root,
      "--storage-path",
      storagePath,
      "--mcp-path",
      mcpPath,
    ]);

    assert.match(output, /MarvMem Agent TUI/);
    assert.match(output, /Storage:/);
    assert.match(output, /Codex/);
    assert.match(output, /Antigravity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent service install writes stable config and LaunchAgent plist without starting", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-agent-service-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "marvmem-mcp.js");

  try {
    const output = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-agent.ts"),
      "service",
      "install",
      "--home",
      root,
      "--storage-path",
      storagePath,
      "--mcp-path",
      mcpPath,
      "--port",
      "3391",
      "--no-start",
    ]);
    const parsed = JSON.parse(output);
    assert.match(parsed.url, /^http:\/\/127\.0\.0\.1:3391\/console\?apiKey=mm_/);
    assert.equal(parsed.started, false);

    const config = JSON.parse(await readFile(join(root, ".marvmem", "agent-service.json"), "utf8"));
    assert.equal(config.storagePath, storagePath);
    assert.equal(config.mcpPath, mcpPath);
    assert.equal(config.port, 3391);
    assert.match(config.apiKey, /^mm_/);

    const plist = await readFile(join(root, "Library", "LaunchAgents", "com.marvmem.agent.plist"), "utf8");
    assert.match(plist, /<string>serve<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>/);
    assert.match(plist, new RegExp(escapeRegExp(join(root, ".marvmem", "agent-service.json"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install all can create the local service without invoking launchctl", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-agent-install-all-"));
  const storagePath = join(root, "memory.sqlite");
  const mcpPath = join(root, "marvmem-mcp.js");

  try {
    const output = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-agent.ts"),
      "install",
      "all",
      "--home",
      root,
      "--storage-path",
      storagePath,
      "--mcp-path",
      mcpPath,
      "--skip-mcp",
      "--skip-import",
      "--skip-instructions",
      "--no-service-start",
      "--service-port",
      "3392",
    ]);
    const parsed = JSON.parse(output);
    assert.equal(parsed.results.length, 5);
    assert.equal(parsed.service.started, false);
    assert.match(parsed.service.url, /^http:\/\/127\.0\.0\.1:3392\/console\?apiKey=mm_/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runInstaller(
  agent: string,
  home: string,
  storagePath: string,
  mcpPath: string,
  ...extra: string[]
): Promise<string> {
  return await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    join(process.cwd(), "src/bin/marvmem-agent.ts"),
    "install",
    agent,
    "--home",
    home,
    "--storage-path",
    storagePath,
    "--mcp-path",
    mcpPath,
    ...extra,
  ]);
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
