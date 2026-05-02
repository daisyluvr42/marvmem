import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import { openSqliteDatabase } from "../system/sqlite.js";

export const AGENT_IDS = ["codex", "claude", "cursor", "copilot", "antigravity"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export type AgentInstallOptions = {
  home?: string;
  storagePath?: string;
  mcpPath?: string;
  sessionsRoot?: string;
  skipMcp?: boolean;
  skipImport?: boolean;
  skipInstructions?: boolean;
};

export type ResolvedAgentInstallOptions = {
  home: string;
  storagePath: string;
  mcpPath: string;
  sessionsRoot?: string;
  skipMcp: boolean;
  skipImport: boolean;
  skipInstructions: boolean;
};

export type AgentInstallResult = {
  agent: AgentId;
  mcp: "installed" | "skipped";
  import: "imported" | "skipped";
  instructions: "updated" | "skipped";
  importSummary?: Record<string, unknown>;
};

export type AgentStatus = {
  agent: AgentId;
  label: string;
  scopeId: string;
  paths: {
    configPath: string;
    instructionsPath?: string;
    sessionsRoot: string;
    storagePath: string;
    mcpPath: string;
  };
  mcp: {
    configured: boolean;
    storagePathMatches: boolean;
    command?: string;
    args?: string[];
  };
  instructions: {
    supported: boolean;
    installed: boolean;
  };
  sessions: {
    rootExists: boolean;
  };
  imported: {
    memories: number;
    tasks: number;
    source: string;
  };
};

type AgentDefinition = {
  label: string;
  scopeId: string;
  importBin: string;
  defaultSessionsRoot(home: string): string;
  configPath(home: string): string;
  instructionsPath?(home: string): string;
};

export const AGENTS: Record<AgentId, AgentDefinition> = {
  codex: {
    label: "Codex",
    scopeId: "codex",
    importBin: "marvmem-codex-import",
    defaultSessionsRoot: (home) => join(home, ".codex", "sessions"),
    configPath: (home) => join(home, ".codex", "config.toml"),
    instructionsPath: (home) => join(home, ".codex", "AGENTS.md"),
  },
  claude: {
    label: "Claude Code",
    scopeId: "claude",
    importBin: "marvmem-claude-import",
    defaultSessionsRoot: (home) => join(home, ".claude", "projects"),
    configPath: (home) => join(home, ".claude.json"),
    instructionsPath: (home) => join(home, ".claude", "CLAUDE.md"),
  },
  cursor: {
    label: "Cursor",
    scopeId: "cursor",
    importBin: "marvmem-cursor-import",
    defaultSessionsRoot: (home) => join(home, "Library", "Application Support", "Cursor", "User"),
    configPath: (home) => join(home, ".cursor", "mcp.json"),
    instructionsPath: (home) => join(home, ".cursor", "rules", "marvmem.mdc"),
  },
  copilot: {
    label: "GitHub Copilot",
    scopeId: "copilot",
    importBin: "marvmem-copilot-import",
    defaultSessionsRoot: (home) => join(home, "Library", "Application Support", "Code", "User"),
    configPath: (home) => join(home, ".copilot", "mcp-config.json"),
    instructionsPath: (home) => join(home, ".copilot", "copilot-instructions.md"),
  },
  antigravity: {
    label: "Antigravity",
    scopeId: "antigravity",
    importBin: "marvmem-antigravity-import",
    defaultSessionsRoot: (home) => join(home, ".gemini", "antigravity", "brain"),
    configPath: (home) => join(home, ".gemini", "antigravity", "mcp_config.json"),
    instructionsPath: (home) => join(home, ".gemini", "GEMINI.md"),
  },
};

export function resolveAgentOptions(options: AgentInstallOptions = {}): ResolvedAgentInstallOptions {
  return {
    home: options.home ?? process.env.MARVMEM_AGENT_HOME ?? homedir(),
    storagePath: options.storagePath ?? process.env.MARVMEM_STORAGE_PATH ?? defaultMemoryMcpStoragePath(),
    mcpPath: options.mcpPath ?? defaultAgentMcpPath(),
    sessionsRoot: options.sessionsRoot,
    skipMcp: options.skipMcp ?? false,
    skipImport: options.skipImport ?? false,
    skipInstructions: options.skipInstructions ?? false,
  };
}

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function parseAgentTarget(target: string): AgentId[] {
  if (target === "all") {
    return [...AGENT_IDS];
  }
  if (isAgentId(target)) {
    return [target];
  }
  throw new Error(`Unsupported agent: ${target}`);
}

export function defaultAgentMcpPath(): string {
  return agentBinPath("marvmem-mcp");
}

export function agentBinPath(name: string): string {
  const current = fileURLToPath(import.meta.url);
  const dir = dirname(current);
  const rootDir = basename(dir) === "agents" ? dirname(dir) : dir;
  return join(rootDir, "bin", `${name}${extname(current)}`);
}

export async function installAgent(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<AgentInstallResult> {
  const options = resolveAgentOptions(input);
  const result: AgentInstallResult = {
    agent,
    mcp: "skipped",
    import: "skipped",
    instructions: "skipped",
  };

  if (!options.skipMcp) {
    await installMcp(agent, options);
    result.mcp = "installed";
  }
  if (!options.skipImport) {
    result.importSummary = await importSessions(agent, options);
    result.import = "imported";
  }
  if (!options.skipInstructions) {
    const changed = await installInstructions(agent, options);
    result.instructions = changed ? "updated" : "skipped";
  }

  return result;
}

export async function importSessions(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<Record<string, unknown>> {
  const options = resolveAgentOptions(input);
  const config = AGENTS[agent];
  const importerPath = agentBinPath(config.importBin);
  const args = nodeScriptArgs(importerPath);
  args.push(options.sessionsRoot ?? config.defaultSessionsRoot(options.home));
  args.push("--storage-path", options.storagePath, "--scope-type", "agent", "--scope-id", config.scopeId);
  const output = await execFileAsync(process.execPath, args);
  return parseJsonOutput(output.stdout);
}

export async function installInstructions(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<boolean> {
  const options = resolveAgentOptions(input);
  const path = AGENTS[agent].instructionsPath?.(options.home);
  if (!path) {
    return false;
  }
  if (agent === "cursor") {
    return await writeCursorRule(path, instructionBlock(agent));
  }
  return await writeMarkedBlock(path, instructionBlock(agent));
}

export async function getAgentStatuses(
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<AgentStatus[]> {
  return await Promise.all(AGENT_IDS.map((agent) => getAgentStatus(agent, input)));
}

export async function getAgentStatus(
  agent: AgentId,
  input: AgentInstallOptions | ResolvedAgentInstallOptions = {},
): Promise<AgentStatus> {
  const options = resolveAgentOptions(input);
  const config = AGENTS[agent];
  const sessionsRoot = options.sessionsRoot ?? config.defaultSessionsRoot(options.home);
  const instructionsPath = config.instructionsPath?.(options.home);
  const mcp = await inspectMcpConfig(agent, options);
  const installedInstructions = instructionsPath ? await textIncludes(instructionsPath, "marvmem-agent-instructions:start") : false;

  return {
    agent,
    label: config.label,
    scopeId: config.scopeId,
    paths: {
      configPath: config.configPath(options.home),
      instructionsPath,
      sessionsRoot,
      storagePath: options.storagePath,
      mcpPath: options.mcpPath,
    },
    mcp,
    instructions: {
      supported: Boolean(instructionsPath),
      installed: installedInstructions,
    },
    sessions: {
      rootExists: await pathExists(sessionsRoot),
    },
    imported: await countImported(agent, options.storagePath),
  };
}

async function installMcp(agent: AgentId, options: ResolvedAgentInstallOptions): Promise<void> {
  if (agent === "codex") {
    await writeCodexMcpConfig(options);
    return;
  }
  if (agent === "claude") {
    await runClaudeMcpInstall(options);
    return;
  }
  if (agent === "cursor") {
    await writeJsonMcpConfig(AGENTS.cursor.configPath(options.home), "cursor", options);
    return;
  }
  if (agent === "antigravity") {
    await writeJsonMcpConfig(AGENTS.antigravity.configPath(options.home), "antigravity", options);
    return;
  }
  await writeJsonMcpConfig(AGENTS.copilot.configPath(options.home), "copilot", options);
}

async function inspectMcpConfig(
  agent: AgentId,
  options: ResolvedAgentInstallOptions,
): Promise<AgentStatus["mcp"]> {
  if (agent === "codex") {
    const text = await readText(AGENTS.codex.configPath(options.home));
    const configured = text.includes("[mcp_servers.marvmem]");
    return {
      configured,
      storagePathMatches: configured && text.includes(`MARVMEM_STORAGE_PATH = "${escapeToml(options.storagePath)}"`),
      command: configured ? "node" : undefined,
      args: configured && text.includes(options.mcpPath) ? [options.mcpPath] : undefined,
    };
  }

  if (agent === "claude") {
    try {
      const output = await execFileAsync("claude", ["mcp", "get", "marvmem"], 5000);
      const text = `${output.stdout}\n${output.stderr}`;
      const configured = text.includes("marvmem");
      return {
        configured,
        storagePathMatches: configured && text.includes(options.storagePath),
        command: configured ? "node" : undefined,
        args: configured && text.includes(options.mcpPath) ? [options.mcpPath] : undefined,
      };
    } catch {
      return { configured: false, storagePathMatches: false };
    }
  }

  const config = await readJsonObject(AGENTS[agent].configPath(options.home));
  const server = asObject(asObject(config.mcpServers).marvmem);
  const env = asObject(server.env);
  const args = stringArray(server.args);
  return {
    configured: Object.keys(server).length > 0,
    storagePathMatches: env.MARVMEM_STORAGE_PATH === options.storagePath,
    command: stringValue(server.command),
    args,
  };
}

async function countImported(agent: AgentId, storagePath: string): Promise<AgentStatus["imported"]> {
  const source = `${agent}_session_import`;
  if (!(await pathExists(storagePath))) {
    return { memories: 0, tasks: 0, source };
  }

  const db = openSqliteDatabase(storagePath);
  try {
    const memories =
      (db.prepare("SELECT COUNT(*) AS count FROM memory_items WHERE source = ?").get(source) as { count?: number } | undefined)
        ?.count ?? 0;
    const tasks =
      (
        db.prepare("SELECT COUNT(*) AS count FROM task_context WHERE task_id LIKE ?").get(`${agent}:%`) as
          | { count?: number }
          | undefined
      )?.count ?? 0;
    return { memories, tasks, source };
  } finally {
    db.close();
  }
}

async function writeCodexMcpConfig(options: ResolvedAgentInstallOptions): Promise<void> {
  const configPath = AGENTS.codex.configPath(options.home);
  const current = await readText(configPath);
  const next = `${removeTomlTable(current, "mcp_servers.marvmem").trimEnd()}

[mcp_servers.marvmem]
command = "node"
args = ["${escapeToml(options.mcpPath)}"]

[mcp_servers.marvmem.env]
MARVMEM_STORAGE_PATH = "${escapeToml(options.storagePath)}"
`;
  await writeText(configPath, `${next.trimStart()}\n`);
}

async function runClaudeMcpInstall(options: ResolvedAgentInstallOptions): Promise<void> {
  const json = JSON.stringify({
    type: "stdio",
    command: "node",
    args: [options.mcpPath],
    env: {
      MARVMEM_STORAGE_PATH: options.storagePath,
    },
  });
  try {
    await execFileAsync("claude", ["mcp", "remove", "--scope", "user", "marvmem"], 10000);
  } catch {
    // No existing user-level server to replace.
  }
  await execFileAsync("claude", ["mcp", "add-json", "--scope", "user", "marvmem", json], 10000);
}

async function writeJsonMcpConfig(
  configPath: string,
  format: "cursor" | "copilot" | "antigravity",
  options: ResolvedAgentInstallOptions,
): Promise<void> {
  const config = await readJsonObject(configPath);
  const servers = asObject(config.mcpServers);
  servers.marvmem =
    format === "cursor" || format === "antigravity"
      ? {
          command: "node",
          args: [options.mcpPath],
          env: {
            MARVMEM_STORAGE_PATH: options.storagePath,
          },
        }
      : {
          type: "local",
          command: "node",
          args: [options.mcpPath],
          env: {
            MARVMEM_STORAGE_PATH: options.storagePath,
          },
          tools: ["*"],
        };
  config.mcpServers = servers;
  await writeJson(configPath, config);
}

function instructionBlock(agent: AgentId): string {
  const scopeId = AGENTS[agent].scopeId;
  return `<!-- marvmem-agent-instructions:start -->
Memory lookup:

- If a task may depend on user-specific preferences, prior project decisions, repo conventions, or earlier troubleshooting history, query MarvMem before answering or editing. Prefer a lightweight \`memory_recall\` using the current request. For cross-agent continuity, omit scope first so MarvMem can search the shared user memory store; for narrow lookups or durable writes, use \`agent:${scopeId}\`. Skip this for trivial, fully self-contained requests.
- After substantial work or when closing a session, distill the session with the current host model and call \`memory_session_commit\` with the rolling summary, any new transcript entries, and durable facts/preferences/decisions. Use \`agent:${scopeId}\` for the session memory unless a narrower project/repo scope is clearly available.
<!-- marvmem-agent-instructions:end -->`;
}

async function writeCursorRule(path: string, block: string): Promise<boolean> {
  const current = await readText(path);
  if (current.trim()) {
    return await writeMarkedBlock(path, block);
  }
  return await writeMarkedBlock(
    path,
    `---
description: MarvMem host-mediated memory workflow
globs:
alwaysApply: true
---

${block}`,
  );
}

async function writeMarkedBlock(path: string, block: string): Promise<boolean> {
  const current = await readText(path);
  const start = "<!-- marvmem-agent-instructions:start -->";
  const end = "<!-- marvmem-agent-instructions:end -->";
  const startIndex = current.indexOf(start);
  const endIndex = current.indexOf(end);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const before = current.slice(0, startIndex).trimEnd();
    const after = current.slice(endIndex + end.length).trimStart();
    const next = [before, block, after].filter(Boolean).join("\n\n");
    if (`${next}\n` === current) {
      return false;
    }
    await writeText(path, `${next}\n`);
    return true;
  }
  const next = current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`;
  await writeText(path, next);
  return true;
}

function nodeScriptArgs(path: string): string[] {
  return extname(path) === ".ts" ? ["--import", "tsx", path] : [path];
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const text = await readText(path);
  if (!text.trim()) {
    return {};
  }
  return asObject(JSON.parse(text));
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function removeTomlTable(content: string, tableName: string): string {
  const lines = content.split("\n");
  const output: string[] = [];
  let skipping = false;
  const tableHeader = `[${tableName}]`;
  const nestedPrefix = `[${tableName}.`;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === tableHeader || trimmed.startsWith(nestedPrefix)) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith("[") && !trimmed.startsWith(nestedPrefix)) {
      skipping = false;
    }
    if (!skipping) {
      output.push(line);
    }
  }
  return output.join("\n");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

async function textIncludes(path: string, needle: string): Promise<boolean> {
  return (await readText(path)).includes(needle);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout || "{}") as unknown;
  return asObject(parsed);
}

function execFileAsync(
  file: string,
  args: string[],
  timeout = 0,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || stdout.trim() || error.message;
        reject(new Error(`${file} ${args.join(" ")} failed: ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
