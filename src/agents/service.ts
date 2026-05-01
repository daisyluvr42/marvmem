import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { apiKeyPrefix, generateApiKey, hashApiKey } from "../auth/keys.js";
import type { Project } from "../auth/types.js";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import { agentBinPath, defaultAgentMcpPath, resolveAgentOptions, type AgentInstallOptions, type ResolvedAgentInstallOptions } from "./manager.js";

export const AGENT_SERVICE_LABEL = "com.marvmem.agent";
const DEFAULT_AGENT_SERVICE_HOST = "127.0.0.1";
const DEFAULT_AGENT_SERVICE_PORT = 3377;

export type AgentServiceConfig = {
  host: string;
  port: number;
  storagePath: string;
  mcpPath: string;
  apiKey: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentServiceOptions = AgentInstallOptions & {
  host?: string;
  port?: number;
  configPath?: string;
  start?: boolean;
};

export type ResolvedAgentServiceOptions = ResolvedAgentInstallOptions & {
  host: string;
  port: number;
  configPath: string;
  plistPath: string;
  logPath: string;
  errorLogPath: string;
  cliPath: string;
  start: boolean;
};

export type AgentServiceInstallResult = {
  configPath: string;
  plistPath: string;
  url: string;
  apiKeyPrefix: string;
  started: boolean;
};

export type AgentServiceStatus = {
  configured: boolean;
  installed: boolean;
  running: boolean;
  configPath: string;
  plistPath: string;
  url?: string;
};

export function resolveAgentServiceOptions(input: AgentServiceOptions = {}): ResolvedAgentServiceOptions {
  const agentOptions = resolveAgentOptions(input);
  const home = agentOptions.home;
  const host = input.host ?? DEFAULT_AGENT_SERVICE_HOST;
  const port = input.port ?? DEFAULT_AGENT_SERVICE_PORT;
  if (!host.trim()) {
    throw new Error("Invalid service host");
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid service port");
  }
  return {
    ...agentOptions,
    host,
    port,
    configPath: input.configPath ?? defaultAgentServiceConfigPath(home),
    plistPath: defaultAgentServicePlistPath(home),
    logPath: join(home, ".marvmem", "agent-service.out.log"),
    errorLogPath: join(home, ".marvmem", "agent-service.err.log"),
    cliPath: agentBinPath("marvmem-agent"),
    start: input.start ?? true,
  };
}

export function defaultAgentServiceConfigPath(home = homedir()): string {
  return join(home, ".marvmem", "agent-service.json");
}

export function defaultAgentServicePlistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${AGENT_SERVICE_LABEL}.plist`);
}

export async function installAgentService(input: AgentServiceOptions = {}): Promise<AgentServiceInstallResult> {
  const options = resolveAgentServiceOptions(input);
  const config = await ensureAgentServiceConfig(input);
  await writeAgentServicePlist(options);
  if (options.start) {
    await startAgentService(options);
  }
  return {
    configPath: options.configPath,
    plistPath: options.plistPath,
    url: serviceUrl(config),
    apiKeyPrefix: apiKeyPrefix(config.apiKey),
    started: options.start,
  };
}

export async function ensureAgentServiceConfig(input: AgentServiceOptions | ResolvedAgentServiceOptions = {}): Promise<AgentServiceConfig> {
  const options = "configPath" in input && "plistPath" in input ? input : resolveAgentServiceOptions(input);
  const existing = await readAgentServiceConfig(options.configPath);
  const now = new Date().toISOString();
  const config: AgentServiceConfig = existing
    ? {
        ...existing,
        host: hasOwn(input, "host") ? options.host : existing.host,
        port: hasOwn(input, "port") ? options.port : existing.port,
        storagePath: hasOwn(input, "storagePath") ? options.storagePath : existing.storagePath,
        mcpPath: hasOwn(input, "mcpPath") ? options.mcpPath || defaultAgentMcpPath() : existing.mcpPath,
        updatedAt: now,
      }
    : {
        host: options.host,
        port: options.port,
        storagePath: options.storagePath || defaultMemoryMcpStoragePath(),
        mcpPath: options.mcpPath || defaultAgentMcpPath(),
        apiKey: generateApiKey(),
        projectId: `proj_local_${Date.now().toString(36)}`,
        createdAt: now,
        updatedAt: now,
      };
  await writeAgentServiceConfig(options.configPath, config);
  return config;
}

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export async function readAgentServiceConfig(path: string): Promise<AgentServiceConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as AgentServiceConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function projectFromAgentServiceConfig(config: AgentServiceConfig): Project {
  return {
    id: config.projectId,
    name: "Local MarvMem",
    apiKeyHash: hashApiKey(config.apiKey),
    createdAt: config.createdAt,
  };
}

export async function getAgentServiceStatus(input: AgentServiceOptions = {}): Promise<AgentServiceStatus> {
  const options = resolveAgentServiceOptions({ ...input, start: false });
  const config = await readAgentServiceConfig(options.configPath);
  const installed = await fileExists(options.plistPath);
  return {
    configured: Boolean(config),
    installed,
    running: config ? await isServiceHealthy(config) : false,
    configPath: options.configPath,
    plistPath: options.plistPath,
    url: config ? serviceUrl(config) : undefined,
  };
}

export async function startAgentService(input: AgentServiceOptions | ResolvedAgentServiceOptions = {}): Promise<void> {
  const options = "configPath" in input && "plistPath" in input ? input : resolveAgentServiceOptions(input);
  await execLaunchctl(["bootstrap", launchctlDomain(), options.plistPath], true);
  await execLaunchctl(["enable", `${launchctlDomain()}/${AGENT_SERVICE_LABEL}`], true);
  await execLaunchctl(["kickstart", "-k", `${launchctlDomain()}/${AGENT_SERVICE_LABEL}`]);
}

export async function stopAgentService(input: AgentServiceOptions = {}): Promise<void> {
  const options = resolveAgentServiceOptions({ ...input, start: false });
  await execLaunchctl(["bootout", launchctlDomain(), options.plistPath], true);
}

export async function uninstallAgentService(input: AgentServiceOptions = {}): Promise<void> {
  const options = resolveAgentServiceOptions({ ...input, start: false });
  await stopAgentService(options);
  await rm(options.plistPath, { force: true });
}

export function serviceUrl(config: AgentServiceConfig): string {
  return `http://${config.host}:${config.port}/console?apiKey=${encodeURIComponent(config.apiKey)}#dashboard`;
}

async function writeAgentServiceConfig(path: string, config: AgentServiceConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeAgentServicePlist(options: ResolvedAgentServiceOptions): Promise<void> {
  await mkdir(dirname(options.plistPath), { recursive: true });
  const content = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${AGENT_SERVICE_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXml(process.execPath)}</string>`,
    `    <string>${escapeXml(options.cliPath)}</string>`,
    `    <string>serve</string>`,
    `    <string>--config</string>`,
    `    <string>${escapeXml(options.configPath)}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(options.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(options.errorLogPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
  await writeFile(options.plistPath, content);
}

async function isServiceHealthy(config: AgentServiceConfig): Promise<boolean> {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/v1/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function launchctlDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("LaunchAgent services are only supported on Unix-like systems");
  }
  return `gui/${uid}`;
}

async function execLaunchctl(args: string[], ignoreAlreadyDone = false): Promise<void> {
  try {
    await execFileAsync("launchctl", args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ignoreAlreadyDone && /already|service.*not.*found|No such process|Input\/output error/i.test(message)) {
      return;
    }
    throw error;
  }
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve();
    });
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
