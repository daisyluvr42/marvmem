#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createMarvMem } from "../core/index.js";
import type { MemoryScope } from "../core/types.js";
import {
  createOpenClawInferencer,
  createOpenClawMemoryAdapter,
  type OpenClawInferencerConfig,
} from "../adapters/openclaw.js";

type Command =
  | "sync-home"
  | "before-prompt"
  | "after-turn"
  | "flush-session"
  | "install-plugin";

type CliOptions = {
  assistantMessage?: string;
  command: Command;
  inferencer?: OpenClawInferencerConfig;
  openclawHome: string;
  recentMessages: string[];
  scope: MemoryScope;
  storagePath: string;
  userMessage?: string;
};

type InferencerRequestAuth = NonNullable<NonNullable<OpenClawInferencerConfig["request"]>["auth"]>;

const HELP = `marvmem-openclaw

Bridge OpenClaw sessions into MarvMem.

Commands:
  sync-home       Import OpenClaw memory files into MarvMem if needed, then write the current projection back
  before-prompt   Build recalled context for an OpenClaw prompt and print JSON to stdout
  after-turn      Record a completed OpenClaw turn and refresh OpenClaw memory files
  flush-session   Run session-level summarization and refresh OpenClaw memory files
  install-plugin  Install an OpenClaw plugin that calls this bridge through official hooks

Shared options:
  --openclaw-home <path>  OpenClaw home root (default: ~)
  --storage-path <path>   MarvMem SQLite path (default: <openclaw-home>/.openclaw/marvmem.sqlite)
  --scope-type <type>     Scope type (default: agent)
  --scope-id <id>         Scope id (default: openclaw)

Command options:
  before-prompt:
    --user-message <text>
    --recent-message <text>   Repeat to pass prior visible messages

  after-turn:
    --user-message <text>
    --assistant-message <text>

Environment:
  MARVMEM_OPENCLAW_HOME
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID

Bridge-only options:
  --inferencer <json>       Resolved OpenClaw runtime model config used for MarvMem summaries
`;

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2), process.env);
  if (options.command === "install-plugin") {
    await installPlugin(options);
    return;
  }

  const memory = createMarvMem({
    storagePath: options.storagePath,
    ...(options.inferencer ? { inferencer: createOpenClawInferencer(options.inferencer) } : {}),
  });
  const adapter = createOpenClawMemoryAdapter({
    memory,
    defaultScopes: [options.scope],
    files: resolveOpenClawFiles(options.openclawHome),
  });

  if (options.command === "sync-home") {
    const existing = await memory.list({ scopes: [options.scope], limit: 1 });
    if (existing.length === 0) {
      await adapter.importExistingMemory();
    }
    await adapter.syncProjection();
    return;
  }

  if (options.command === "before-prompt") {
    const prompt = await adapter.beforePrompt({
      userMessage: options.userMessage ?? "",
      recentMessages: options.recentMessages,
    });
    process.stdout.write(`${JSON.stringify(prompt)}\n`);
    return;
  }

  if (options.command === "after-turn") {
    await adapter.afterTurn({
      userMessage: options.userMessage ?? "",
      assistantMessage: options.assistantMessage ?? "",
    });
    return;
  }

  if (options.recentMessages.length > 0) {
    const sessionSummary = options.recentMessages
      .map((message) => message.trim())
      .filter(Boolean)
      .join("\n");
    if (sessionSummary) {
      await memory.active.distillContext({
        scope: options.scope,
        sessionSummary,
      });
    }
    await adapter.syncProjection();
    return;
  }

  await adapter.flushSession();
}

function parseCli(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const command = argv[0];
  if (!command || command === "--help") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (
    command !== "sync-home" &&
    command !== "before-prompt" &&
    command !== "after-turn" &&
    command !== "flush-session" &&
    command !== "install-plugin"
  ) {
    throw new Error(`Unknown command: ${command}`);
  }

  let openclawHome = env.MARVMEM_OPENCLAW_HOME ?? homedir();
  let storagePath = env.MARVMEM_STORAGE_PATH;
  let scopeType = env.MARVMEM_SCOPE_TYPE ?? "agent";
  let scopeId = env.MARVMEM_SCOPE_ID ?? "openclaw";
  let inferencer: OpenClawInferencerConfig | undefined;
  let userMessage: string | undefined;
  let assistantMessage: string | undefined;
  const recentMessages: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--openclaw-home") {
      openclawHome = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--storage-path") {
      storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-type") {
      scopeType = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-id") {
      scopeId = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--inferencer") {
      inferencer = parseInferencerFlag(readFlagValue(argv, ++index, arg));
      continue;
    }
    if (arg === "--user-message") {
      userMessage = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--assistant-message") {
      assistantMessage = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--recent-message") {
      recentMessages.push(readFlagValue(argv, ++index, arg));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    assistantMessage,
    command,
    inferencer,
    openclawHome,
    recentMessages,
    scope: {
      type: scopeType as MemoryScope["type"],
      id: scopeId,
    },
    storagePath: storagePath ?? join(openclawHome, ".openclaw", "marvmem.sqlite"),
    userMessage,
  };
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseInferencerFlag(value: string): OpenClawInferencerConfig {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid --inferencer payload");
  }
  const baseUrl =
    "baseUrl" in parsed && typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
  const model = "model" in parsed && typeof parsed.model === "string" ? parsed.model.trim() : "";
  const api = "api" in parsed && typeof parsed.api === "string" ? parsed.api.trim() : "";
  if (!baseUrl || !model || !api) {
    throw new Error("Invalid --inferencer payload");
  }
  return {
    api,
    model,
    baseUrl,
    ...("apiKey" in parsed && typeof parsed.apiKey === "string" && parsed.apiKey.trim()
      ? { apiKey: parsed.apiKey.trim() }
      : {}),
    ...("headers" in parsed ? { headers: coerceHeaders(parsed.headers) } : {}),
    ...(parsed.authHeader === true ? { authHeader: true } : {}),
    ...("request" in parsed ? { request: coerceRequest(parsed.request) } : {}),
  };
}

function resolveOpenClawFiles(openclawHome: string) {
  const workspacePath = join(openclawHome, ".openclaw", "workspace");
  return {
    workspacePath,
    memoryPath: join(workspacePath, "MEMORY.md"),
    userPath: join(workspacePath, "USER.md"),
    dreamsPath: join(workspacePath, "DREAMS.md"),
    dailyDir: join(workspacePath, "memory"),
  };
}

function coerceHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalizedKey = key.trim();
    const normalizedValue = entry.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    headers[normalizedKey] = normalizedValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function coerceRequest(value: unknown): OpenClawInferencerConfig["request"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const request = value as Record<string, unknown>;
  const auth = coerceAuth(request.auth);
  const headers = coerceHeaders(request.headers);
  if (!auth && !headers) {
    return undefined;
  }
  return {
    ...(headers ? { headers } : {}),
    ...(auth ? { auth } : {}),
  };
}

function coerceAuth(value: unknown): InferencerRequestAuth | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const auth = value as Record<string, unknown>;
  if (auth.mode === "provider-default") {
    return { mode: "provider-default" };
  }
  if (auth.mode === "authorization-bearer" && typeof auth.token === "string" && auth.token.trim()) {
    return { mode: "authorization-bearer", token: auth.token.trim() };
  }
  if (
    auth.mode === "header" &&
    typeof auth.headerName === "string" &&
    auth.headerName.trim() &&
    typeof auth.value === "string" &&
    auth.value.trim()
  ) {
    return {
      mode: "header",
      headerName: auth.headerName.trim(),
      value: auth.value.trim(),
      ...(typeof auth.prefix === "string" && auth.prefix.trim()
        ? { prefix: auth.prefix.trim() }
        : {}),
    };
  }
  return undefined;
}

async function installPlugin(options: CliOptions): Promise<void> {
  const stateDir = join(options.openclawHome, ".openclaw");
  const pluginDir = join(stateDir, "plugins", "marvmem");
  const configPath = join(stateDir, "openclaw.json");

  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "package.json"),
    JSON.stringify(buildPluginPackageJson(), null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(buildPluginManifest(), null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    join(pluginDir, "index.mjs"),
    buildPluginModule({
      openclawHome: options.openclawHome,
      storagePath: options.storagePath,
      scope: options.scope,
    }),
    "utf8",
  );

  await writeOpenClawConfig(configPath, pluginDir);

  const memory = createMarvMem({ storagePath: options.storagePath });
  const adapter = createOpenClawMemoryAdapter({
    memory,
    defaultScopes: [options.scope],
    files: resolveOpenClawFiles(options.openclawHome),
  });
  const existing = await memory.list({ scopes: [options.scope], limit: 1 });
  if (existing.length === 0) {
    await adapter.importExistingMemory();
  }
  await adapter.syncProjection();
}

function buildPluginPackageJson() {
  return {
    name: "marvmem-openclaw-plugin",
    version: "1.0.0",
    type: "module",
    openclaw: {
      extensions: ["./index.mjs"],
      compat: {
        pluginApi: ">=2026.3.24-beta.2",
        minGatewayVersion: "2026.3.24-beta.2",
      },
      build: {
        openclawVersion: "2026.3.24-beta.2",
        pluginSdkVersion: "2026.3.24-beta.2",
      },
    },
  };
}

function buildPluginManifest() {
  return {
    id: "marvmem",
    name: "MarvMem",
    description: "Bridge OpenClaw memory through MarvMem",
    configSchema: {
      type: "object",
      additionalProperties: false,
    },
  };
}

function buildPluginModule(input: {
  openclawHome: string;
  storagePath: string;
  scope: MemoryScope;
}): string {
  const bridgePath = realpathSync(fileURLToPath(import.meta.url));
  const nodePath = process.execPath;
  return `import { execFileSync } from "node:child_process";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const NODE = ${JSON.stringify(nodePath)};
const BRIDGE = ${JSON.stringify(bridgePath)};
const OPENCLAW_HOME = ${JSON.stringify(input.openclawHome)};
const STORAGE_PATH = ${JSON.stringify(input.storagePath)};
const SCOPE_TYPE = ${JSON.stringify(input.scope.type)};
const SCOPE_ID = ${JSON.stringify(input.scope.id)};
const MANAGED_FILES_NOTE =
  "MarvMem manages USER.md, MEMORY.md, DREAMS.md, and memory/*.md as projection files. Do not edit those files directly.";
const MAX_RECENT_MESSAGES = 12;
const turnPromptByRun = new Map();
const recentMessagesBySession = new Map();
const inferencerBySession = new Map();

function baseArgs() {
  return [
    "--openclaw-home",
    OPENCLAW_HOME,
    "--storage-path",
    STORAGE_PATH,
    "--scope-type",
    SCOPE_TYPE,
    "--scope-id",
    SCOPE_ID,
  ];
}

function inferencerArgs(config) {
  if (!config) {
    return [];
  }
  return ["--inferencer", JSON.stringify(config)];
}

function runJson(command, args) {
  try {
    const stdout = execFileSync(NODE, [BRIDGE, command, ...baseArgs(), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function runVoid(command, args) {
  try {
    execFileSync(NODE, [BRIDGE, command, ...baseArgs(), ...args], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // best effort bridge only
  }
}

function normalizeText(value) {
  const text = typeof value === "string" ? value : "";
  return text.trim();
}

function textFromPart(part) {
  if (typeof part === "string") {
    return normalizeText(part);
  }
  if (!part || typeof part !== "object") {
    return "";
  }
  if (typeof part.text === "string") {
    return normalizeText(part.text);
  }
  if (typeof part.content === "string") {
    return normalizeText(part.content);
  }
  return "";
}

function textFromMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  if (typeof message.content === "string") {
    return normalizeText(message.content);
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => textFromPart(part))
      .filter(Boolean)
      .join("\\n")
      .trim();
  }
  if (typeof message.text === "string") {
    return normalizeText(message.text);
  }
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => textFromPart(part))
      .filter(Boolean)
      .join("\\n")
      .trim();
  }
  return "";
}

function readRole(message) {
  return message && typeof message === "object" && typeof message.role === "string"
    ? message.role
    : "";
}

function collectRecentMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .map((message) => {
      const role = readRole(message);
      const text = textFromMessage(message);
      if (!text) {
        return "";
      }
      return role === "assistant" || role === "user" ? \`\${role}: \${text}\` : text;
    })
    .filter(Boolean)
    .slice(-8)
    .map((message) => (message.length > 800 ? \`\${message.slice(0, 797).trimEnd()}...\` : message));
}

function runKeyFromContext(ctx) {
  if (ctx && typeof ctx.runId === "string" && ctx.runId) {
    return \`run:\${ctx.runId}\`;
  }
  if (ctx && typeof ctx.sessionId === "string" && ctx.sessionId) {
    return \`session:\${ctx.sessionId}\`;
  }
  if (ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey) {
    return \`session:\${ctx.sessionKey}\`;
  }
  return "";
}

function sessionKeyFromContext(ctx) {
  if (ctx && typeof ctx.sessionId === "string" && ctx.sessionId) {
    return \`session:\${ctx.sessionId}\`;
  }
  if (ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey) {
    return \`session:\${ctx.sessionKey}\`;
  }
  return "";
}

function readRecentSessionMessages(ctx, fallbackMessages) {
  const key = sessionKeyFromContext(ctx);
  const stored = key ? recentMessagesBySession.get(key) : undefined;
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.slice(-MAX_RECENT_MESSAGES);
  }
  return collectRecentMessages(fallbackMessages);
}

function rememberTurn(ctx, turn) {
  const key = sessionKeyFromContext(ctx);
  if (!key || !turn) {
    return;
  }
  const next = [...(recentMessagesBySession.get(key) ?? [])];
  if (turn.userMessage) {
    next.push(\`user: \${turn.userMessage}\`);
  }
  if (turn.assistantMessage) {
    next.push(\`assistant: \${turn.assistantMessage}\`);
  }
  recentMessagesBySession.set(key, next.slice(-MAX_RECENT_MESSAGES));
}

function stringHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const next = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    next[normalizedKey] = normalizedValue;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  const headers = stringHeaders(request.headers);
  const auth = request.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return headers ? { headers } : undefined;
  }
  if (auth.mode === "provider-default") {
    return headers ? { headers, auth: { mode: "provider-default" } } : { auth: { mode: "provider-default" } };
  }
  if (auth.mode === "authorization-bearer" && stringValue(auth.token)) {
    return {
      ...(headers ? { headers } : {}),
      auth: { mode: "authorization-bearer", token: stringValue(auth.token) },
    };
  }
  if (auth.mode === "header" && stringValue(auth.headerName) && stringValue(auth.value)) {
    return {
      ...(headers ? { headers } : {}),
      auth: {
        mode: "header",
        headerName: stringValue(auth.headerName),
        value: stringValue(auth.value),
        ...(stringValue(auth.prefix) ? { prefix: stringValue(auth.prefix) } : {}),
      },
    };
  }
  return headers ? { headers } : undefined;
}

async function resolveInferencerConfig(api, ctx) {
  const providerId = stringValue(ctx && ctx.modelProviderId);
  const modelId = stringValue(ctx && ctx.modelId);
  if (!providerId || !modelId) {
    return null;
  }
  const loadConfig = api?.runtime?.config?.loadConfig;
  const getRuntimeAuthForModel = api?.runtime?.modelAuth?.getRuntimeAuthForModel;
  if (typeof loadConfig !== "function" || typeof getRuntimeAuthForModel !== "function") {
    return null;
  }
  try {
    const cfg = loadConfig();
    const providerConfig = cfg?.models?.providers?.[providerId];
    if (!providerConfig || !Array.isArray(providerConfig.models)) {
      return null;
    }
    const modelConfig = providerConfig.models.find((model) => model && model.id === modelId);
    if (!modelConfig) {
      return null;
    }
    const baseUrl = stringValue(providerConfig.baseUrl);
    const apiName = stringValue(modelConfig.api) || stringValue(providerConfig.api);
    if (!baseUrl || !apiName) {
      return null;
    }
    const runtimeModel = {
      provider: providerId,
      id: modelId,
      api: apiName,
      baseUrl,
      headers: {
        ...(stringHeaders(providerConfig.headers) ?? {}),
        ...(stringHeaders(modelConfig.headers) ?? {}),
      },
    };
    const runtimeAuth = await getRuntimeAuthForModel({
      model: runtimeModel,
      cfg,
      workspaceDir: ctx && typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : undefined,
    });
    const request = sanitizeRequest(runtimeAuth?.request);
    return {
      api: apiName,
      model: modelId,
      baseUrl: stringValue(runtimeAuth?.baseUrl) || baseUrl,
      ...(stringValue(runtimeAuth?.apiKey) ? { apiKey: stringValue(runtimeAuth.apiKey) } : {}),
      ...(providerConfig.authHeader === true ? { authHeader: true } : {}),
      ...(Object.keys(runtimeModel.headers).length > 0 ? { headers: runtimeModel.headers } : {}),
      ...(request ? { request } : {}),
    };
  } catch {
    return null;
  }
}

function readLastTurn(messages, fallbackUserMessage) {
  if (!Array.isArray(messages)) {
    return fallbackUserMessage ? { userMessage: fallbackUserMessage, assistantMessage: "" } : null;
  }
  let assistantMessage = "";
  let userMessage = normalizeText(fallbackUserMessage);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = readRole(message);
    const text = textFromMessage(message);
    if (!assistantMessage && role === "assistant" && text) {
      assistantMessage = text;
      continue;
    }
    if (!userMessage && role === "user" && text) {
      userMessage = text;
      break;
    }
  }
  if (!userMessage) {
    return null;
  }
  return { userMessage, assistantMessage };
}

export default definePluginEntry({
  id: "marvmem",
  name: "MarvMem",
  description: "Bridge OpenClaw memory through MarvMem",
  register(api) {
    api.on("before_prompt_build", async (event, ctx) => {
      const userMessage = normalizeText(event.prompt);
      const runKey = runKeyFromContext(ctx);
      if (runKey) {
        turnPromptByRun.set(runKey, userMessage);
      }
      const sessionKey = sessionKeyFromContext(ctx);
      const inferencer = await resolveInferencerConfig(api, ctx);
      if (sessionKey && inferencer) {
        inferencerBySession.set(sessionKey, inferencer);
      }
      const recentMessages = readRecentSessionMessages(ctx, event.messages);
      const args = ["--user-message", userMessage];
      for (const message of recentMessages) {
        args.push("--recent-message", message);
      }
      const result = runJson("before-prompt", args);
      if (!result) {
        return { appendSystemContext: MANAGED_FILES_NOTE };
      }
      const appendSystemContext = [MANAGED_FILES_NOTE, normalizeText(result.systemHint)]
        .filter(Boolean)
        .join(" ");
      return {
        appendSystemContext,
        prependContext: normalizeText(result.injectedContext) || undefined,
      };
    });

    api.on("agent_end", async (event, ctx) => {
      const runKey = runKeyFromContext(ctx);
      const cachedUserMessage = runKey ? normalizeText(turnPromptByRun.get(runKey)) : "";
      if (runKey) {
        turnPromptByRun.delete(runKey);
      }
      const turn = readLastTurn(event.messages, cachedUserMessage);
      if (!turn) {
        return;
      }
      runVoid("after-turn", [
        "--user-message",
        turn.userMessage,
        "--assistant-message",
        turn.assistantMessage,
      ]);
      rememberTurn(ctx, turn);
    });

    api.on("session_end", async (_event, ctx) => {
      const sessionKey = sessionKeyFromContext(ctx);
      const inferencer = sessionKey ? inferencerBySession.get(sessionKey) : undefined;
      const recentMessages =
        sessionKey && Array.isArray(recentMessagesBySession.get(sessionKey))
          ? recentMessagesBySession.get(sessionKey).slice(-MAX_RECENT_MESSAGES)
          : [];
      const args = [...inferencerArgs(inferencer)];
      for (const message of recentMessages) {
        args.push("--recent-message", message);
      }
      if (sessionKey) {
        recentMessagesBySession.delete(sessionKey);
        inferencerBySession.delete(sessionKey);
      }
      runVoid("flush-session", args);
    });
  },
});
`;
}

async function writeOpenClawConfig(configPath: string, pluginDir: string): Promise<void> {
  const current = await readConfig(configPath);
  const config = current && typeof current === "object" ? current : {};
  const plugins = asRecord(config.plugins);
  plugins.enabled = plugins.enabled ?? true;

  const load = asRecord(plugins.load);
  const paths = Array.isArray(load.paths) ? [...load.paths] : [];
  if (!paths.includes(pluginDir)) {
    paths.push(pluginDir);
  }
  load.paths = paths;
  plugins.load = load;

  const entries = asRecord(plugins.entries);
  const marvmem = asRecord(entries.marvmem);
  marvmem.enabled = true;
  entries.marvmem = marvmem;

  const memoryCore = asRecord(entries["memory-core"]);
  const memoryCoreConfig = asRecord(memoryCore.config);
  const dreaming = asRecord(memoryCoreConfig.dreaming);
  dreaming.enabled = false;
  memoryCoreConfig.dreaming = dreaming;
  memoryCore.config = memoryCoreConfig;
  entries["memory-core"] = memoryCore;

  plugins.entries = entries;
  config.plugins = plugins;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function readConfig(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
