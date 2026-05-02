import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MarvMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import type { MemoryRuntime } from "../runtime/index.js";
import type { MemoryInferencer, MemoryInferencerResult } from "../system/types.js";
import {
  createSessionMemoryAdapter,
  type MemoryAdapterPromptInput,
  type MemoryAdapterTurnInput,
  type SessionMemoryAdapter,
} from "./base.js";
import {
  listMarkdownFiles,
  parseMarkdownEntries,
  readTextFile,
  writeMarkdownBlocksFile,
  writeMarkdownListFile,
} from "./markdown-sync.js";

const DEFAULT_OPENCLAW_SCOPE: MemoryScope = { type: "agent", id: "openclaw" };
const DEFAULT_MEMORY_MAX_CHARS = 2_200;
const DEFAULT_USER_MAX_CHARS = 1_375;

export type OpenClawMemoryPaths = {
  workspacePath: string;
  memoryPath: string;
  userPath: string;
  dreamsPath: string;
  dailyDir: string;
};

export type OpenClawImportResult = {
  imported: number;
  memoryEntries: number;
  userEntries: number;
  dailyEntries: number;
  dreamEntries: number;
};

export type OpenClawMemoryAdapter = SessionMemoryAdapter & {
  paths: OpenClawMemoryPaths;
  importExistingMemory(): Promise<OpenClawImportResult>;
  syncProjection(): Promise<void>;
};

export type OpenClawInferencerConfig = {
  api: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  request?: {
    headers?: Record<string, string>;
    auth?:
      | { mode: "provider-default" }
      | { mode: "authorization-bearer"; token: string }
      | { mode: "header"; headerName: string; value: string; prefix?: string };
  };
};

type OpenClawInferencerRequestAuth = NonNullable<NonNullable<OpenClawInferencerConfig["request"]>["auth"]>;

export function createOpenClawMemoryAdapter(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
  files?: Partial<OpenClawMemoryPaths>;
  now?: () => Date;
  memoryMaxChars?: number;
  userMaxChars?: number;
}): OpenClawMemoryAdapter {
  const defaultScopes = params.defaultScopes?.length
    ? params.defaultScopes
    : [DEFAULT_OPENCLAW_SCOPE];
  const base = createSessionMemoryAdapter({
    memory: params.memory,
    runtime: params.runtime,
    defaultScopes,
  });
  const paths = resolveOpenClawPaths(params.files);
  const now = params.now ?? (() => new Date());
  const liveDailyBlocks: string[] = [];
  let todaySeedBlocks: string[] | null = null;

  return {
    tools: base.tools,
    paths,
    async beforePrompt(input: MemoryAdapterPromptInput) {
      return await base.beforePrompt({
        ...input,
        scopes: input.scopes ?? defaultScopes,
      });
    },
    async afterTurn(input: MemoryAdapterTurnInput) {
      liveDailyBlocks.push(buildLiveDailyBlock(input));
      await base.afterTurn({
        ...input,
        scopes: input.scopes ?? defaultScopes,
      });
      await syncProjection();
    },
    async flushSession(input = {}) {
      const dailyContent = liveDailyBlocks.map((block) => block.trim()).filter(Boolean).join("\n\n").trim();
      if (dailyContent) {
        await params.memory.remember({
          scope: defaultScopes[0]!,
          kind: "openclaw_daily",
          content: dailyContent,
          summary: summarizeDailyBlock(dailyContent),
          source: "openclaw_session",
          tags: ["openclaw", "daily"],
          metadata: {
            projectionTarget: "daily",
            day: currentDay(now()),
          },
        });
      }
      liveDailyBlocks.length = 0;
      await base.flushSession({
        scopes: input.scopes ?? defaultScopes,
      });
      await syncProjection();
    },
    importExistingMemory,
    syncProjection,
  };

  async function importExistingMemory(): Promise<OpenClawImportResult> {
    const scope = defaultScopes[0]!;
    const memoryEntries = parseMarkdownEntries((await readTextFile(paths.memoryPath)) ?? "");
    const userEntries = parseMarkdownEntries((await readTextFile(paths.userPath)) ?? "");
    for (const entry of memoryEntries) {
      await params.memory.remember({
        scope,
        kind: "note",
        content: entry,
        summary: entry,
        source: "openclaw_import",
        tags: ["openclaw", "memory"],
        metadata: { projectionTarget: "memory" },
      });
    }

    for (const entry of userEntries) {
      await params.memory.remember({
        scope,
        kind: "preference",
        content: entry,
        summary: entry,
        source: "openclaw_import",
        tags: ["openclaw", "user"],
        metadata: { projectionTarget: "user" },
      });
    }

    let dailyEntries = 0;
    for (const file of await listMarkdownFiles(paths.dailyDir)) {
      const day = basename(file, ".md");
      const blocks = parseMarkdownEntries((await readTextFile(file)) ?? "");
      dailyEntries += blocks.length;
      for (const block of blocks) {
        await params.memory.remember({
          scope,
          kind: "openclaw_daily",
          content: block,
          summary: summarizeDailyBlock(block),
          source: "openclaw_import",
          tags: ["openclaw", "daily"],
          metadata: {
            projectionTarget: "daily",
            day,
          },
        });
      }
    }

    const dreamEntries = parseMarkdownEntries((await readTextFile(paths.dreamsPath)) ?? "");
    for (const entry of dreamEntries) {
      await params.memory.remember({
        scope,
        kind: "experience",
        content: entry,
        summary: entry,
        source: "openclaw_import",
        tags: ["openclaw", "dreams"],
        metadata: { projectionTarget: "dreams" },
      });
    }

    todaySeedBlocks = [];

    return {
      imported: memoryEntries.length + userEntries.length + dailyEntries + dreamEntries.length,
      memoryEntries: memoryEntries.length,
      userEntries: userEntries.length,
      dailyEntries,
      dreamEntries: dreamEntries.length,
    };
  }

  async function syncProjection(): Promise<void> {
    const records = await params.memory.list({ scopes: defaultScopes });
    const memoryEntries = records
      .filter((record) => classifyOpenClawRecord(record) === "memory")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const userEntries = records
      .filter((record) => classifyOpenClawRecord(record) === "user")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const dailyBlocks = records
      .filter(
        (record) =>
          classifyOpenClawRecord(record) === "daily" &&
          readRecordDay(record) === currentDay(now()),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((record) => record.content.trim())
      .filter(Boolean);
    const dreamsEntries = records
      .filter((record) => classifyOpenClawRecord(record) === "dreams")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const currentDailyPath = join(paths.dailyDir, `${currentDay(now())}.md`);

    await ensureTodaySeedLoaded(currentDailyPath);

    await writeMarkdownListFile(
      paths.memoryPath,
      memoryEntries,
      params.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS,
    );
    await writeMarkdownListFile(
      paths.userPath,
      userEntries,
      params.userMaxChars ?? DEFAULT_USER_MAX_CHARS,
    );
    await writeMarkdownBlocksFile(currentDailyPath, [
      ...(todaySeedBlocks ?? []),
      ...dailyBlocks,
      ...liveDailyBlocks,
    ]);

    if (dreamsEntries.length > 0 || (await readTextFile(paths.dreamsPath)) !== null) {
      await writeMarkdownListFile(paths.dreamsPath, dreamsEntries);
    }
  }

  async function ensureTodaySeedLoaded(currentDailyPath: string): Promise<void> {
    if (todaySeedBlocks !== null) {
      return;
    }
    const text = await readTextFile(currentDailyPath);
    todaySeedBlocks = text ? parseMarkdownEntries(text) : [];
  }
}

export async function installOpenClawMemoryTakeover(params: Parameters<typeof createOpenClawMemoryAdapter>[0]): Promise<{
  adapter: OpenClawMemoryAdapter;
  imported: OpenClawImportResult;
}> {
  const adapter = createOpenClawMemoryAdapter(params);
  const imported = await adapter.importExistingMemory();
  await adapter.syncProjection();
  return { adapter, imported };
}

export function parseOpenClawInferencerConfig(value: string): OpenClawInferencerConfig {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid inferencer payload");
  }
  const baseUrl =
    "baseUrl" in parsed && typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "";
  const model = "model" in parsed && typeof parsed.model === "string" ? parsed.model.trim() : "";
  const api = "api" in parsed && typeof parsed.api === "string" ? parsed.api.trim() : "";
  if (!baseUrl || !model || !api) {
    throw new Error("Invalid inferencer payload");
  }
  return {
    api,
    model,
    baseUrl,
    ...("apiKey" in parsed && typeof parsed.apiKey === "string" && parsed.apiKey.trim()
      ? { apiKey: parsed.apiKey.trim() }
      : {}),
    ...("headers" in parsed ? { headers: coerceInferencerHeaders(parsed.headers) } : {}),
    ...(parsed.authHeader === true ? { authHeader: true } : {}),
    ...("request" in parsed ? { request: coerceInferencerRequest(parsed.request) } : {}),
  };
}

export function createOpenClawInferencer(config: OpenClawInferencerConfig): MemoryInferencer {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const staticHeaders = normalizeHeaders(config.headers);
  const runtimeHeaders = normalizeHeaders(config.request?.headers);
  const requestAuth = config.request?.auth;

  return async (input) => {
    try {
      const maxTokens = estimateTokenBudget(input.maxChars);
      switch (config.api) {
        case "openai-completions":
        case "github-copilot":
          return await requestOpenAiChat({
            baseUrl,
            model: config.model,
            headers: buildRequestHeaders({
              api: config.api,
              apiKey: config.apiKey,
              authHeader: config.authHeader,
              staticHeaders,
              runtimeHeaders,
              requestAuth,
            }),
            system: input.system,
            prompt: input.prompt,
            maxTokens,
          });
        case "openai-responses":
        case "openai-codex-responses":
        case "azure-openai-responses":
          return await requestOpenAiResponses({
            baseUrl,
            model: config.model,
            headers: buildRequestHeaders({
              api: config.api,
              apiKey: config.apiKey,
              authHeader: config.authHeader,
              staticHeaders,
              runtimeHeaders,
              requestAuth,
            }),
            system: input.system,
            prompt: input.prompt,
            maxTokens,
          });
        case "anthropic-messages":
          return await requestAnthropic({
            baseUrl,
            model: config.model,
            headers: buildRequestHeaders({
              api: config.api,
              apiKey: config.apiKey,
              authHeader: config.authHeader,
              staticHeaders,
              runtimeHeaders,
              requestAuth,
            }),
            system: input.system,
            prompt: input.prompt,
            maxTokens,
          });
        case "google-generative-ai":
          return await requestGemini({
            baseUrl,
            model: config.model,
            headers: buildRequestHeaders({
              api: config.api,
              apiKey: config.apiKey,
              authHeader: config.authHeader,
              staticHeaders,
              runtimeHeaders,
              requestAuth,
            }),
            system: input.system,
            prompt: input.prompt,
            maxTokens,
          });
        case "ollama":
          return await requestOllama({
            baseUrl,
            model: config.model,
            headers: buildRequestHeaders({
              api: config.api,
              apiKey: config.apiKey,
              authHeader: config.authHeader,
              staticHeaders,
              runtimeHeaders,
              requestAuth,
            }),
            system: input.system,
            prompt: input.prompt,
            maxTokens,
          });
        default:
          return {
            ok: false,
            error: `Unsupported OpenClaw inferencer api: ${config.api}`,
          };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function coerceInferencerHeaders(value: unknown): Record<string, string> | undefined {
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

function coerceInferencerRequest(value: unknown): OpenClawInferencerConfig["request"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const request = value as Record<string, unknown>;
  const auth = coerceInferencerAuth(request.auth);
  const headers = coerceInferencerHeaders(request.headers);
  if (!auth && !headers) {
    return undefined;
  }
  return {
    ...(headers ? { headers } : {}),
    ...(auth ? { auth } : {}),
  };
}

function coerceInferencerAuth(value: unknown): OpenClawInferencerRequestAuth | undefined {
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

function resolveOpenClawPaths(files?: Partial<OpenClawMemoryPaths>): OpenClawMemoryPaths {
  const workspacePath = files?.workspacePath ?? join(homedir(), ".openclaw", "workspace");
  return {
    workspacePath,
    memoryPath: files?.memoryPath ?? join(workspacePath, "MEMORY.md"),
    userPath: files?.userPath ?? join(workspacePath, "USER.md"),
    dreamsPath: files?.dreamsPath ?? join(workspacePath, "DREAMS.md"),
    dailyDir: files?.dailyDir ?? join(workspacePath, "memory"),
  };
}

function buildLiveDailyBlock(input: MemoryAdapterTurnInput): string {
  const lines = [
    input.taskTitle?.trim() ? `Task: ${input.taskTitle.trim()}` : "",
    input.userMessage.trim() ? `user: ${input.userMessage.trim()}` : "",
    input.assistantMessage?.trim() ? `assistant: ${input.assistantMessage.trim()}` : "",
    input.toolContext?.trim() ? `context: ${input.toolContext.trim()}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function currentDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function summarizeDailyBlock(content: string): string {
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? content.trim();
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117).trimEnd()}...`;
}

function classifyOpenClawRecord(record: MemoryRecord): "memory" | "user" | "daily" | "dreams" {
  const metadataTarget =
    record.metadata && typeof record.metadata.projectionTarget === "string"
      ? record.metadata.projectionTarget
      : undefined;
  if (
    metadataTarget === "daily" ||
    metadataTarget === "dreams" ||
    metadataTarget === "memory" ||
    metadataTarget === "user"
  ) {
    return metadataTarget;
  }
  if (record.kind === "experience" || record.tags.includes("dreams")) {
    return "dreams";
  }
  if (
    record.kind === "preference" ||
    record.kind === "identity" ||
    record.tags.includes("user")
  ) {
    return "user";
  }
  return "memory";
}

function readRecordDay(record: MemoryRecord): string | undefined {
  return record.metadata && typeof record.metadata.day === "string" ? record.metadata.day : undefined;
}

function summarizeRecord(record: MemoryRecord): string {
  return record.summary?.trim() || record.content.trim();
}

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const next: Record<string, string> = {};
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

function buildRequestHeaders(params: {
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  staticHeaders?: Record<string, string>;
  runtimeHeaders?: Record<string, string>;
  requestAuth?:
    | { mode: "provider-default" }
    | { mode: "authorization-bearer"; token: string }
    | { mode: "header"; headerName: string; value: string; prefix?: string };
}): Headers {
  const headers = new Headers({
    "content-type": "application/json",
  });
  for (const source of [params.staticHeaders, params.runtimeHeaders]) {
    if (!source) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      headers.set(key, value);
    }
  }
  if (params.requestAuth?.mode === "authorization-bearer") {
    headers.set("Authorization", `Bearer ${params.requestAuth.token}`);
    return headers;
  }
  if (params.requestAuth?.mode === "header") {
    headers.set(
      params.requestAuth.headerName,
      params.requestAuth.prefix
        ? `${params.requestAuth.prefix} ${params.requestAuth.value}`
        : params.requestAuth.value,
    );
    return headers;
  }
  if (headers.has("Authorization") || headers.has("x-api-key") || headers.has("x-goog-api-key")) {
    return headers;
  }
  const apiKey = params.apiKey?.trim();
  if (!apiKey) {
    return headers;
  }
  if (params.api === "anthropic-messages") {
    headers.set("x-api-key", apiKey);
    return headers;
  }
  if (params.api === "google-generative-ai") {
    headers.set("x-goog-api-key", apiKey);
    return headers;
  }
  if (
    params.authHeader ||
    params.api === "openai-completions" ||
    params.api === "openai-responses" ||
    params.api === "openai-codex-responses" ||
    params.api === "azure-openai-responses" ||
    params.api === "github-copilot" ||
    params.api === "ollama"
  ) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

async function requestOpenAiChat(params: {
  baseUrl: string;
  model: string;
  headers: Headers;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<MemoryInferencerResult> {
  const response = await fetch(versionedUrl(params.baseUrl, "v1", "chat/completions"), {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.prompt },
      ],
      temperature: 0,
      max_tokens: params.maxTokens,
      stream: false,
    }),
  });
  const data = await parseJsonResponse(response);
  const text = readOpenAiChatText(data);
  return text ? { ok: true, text } : { ok: false, error: formatHttpError(response, data) };
}

async function requestOpenAiResponses(params: {
  baseUrl: string;
  model: string;
  headers: Headers;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<MemoryInferencerResult> {
  const response = await fetch(versionedUrl(params.baseUrl, "v1", "responses"), {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: params.system }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: params.prompt }],
        },
      ],
      max_output_tokens: params.maxTokens,
    }),
  });
  const data = await parseJsonResponse(response);
  const text = readOpenAiResponsesText(data);
  return text ? { ok: true, text } : { ok: false, error: formatHttpError(response, data) };
}

async function requestAnthropic(params: {
  baseUrl: string;
  model: string;
  headers: Headers;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<MemoryInferencerResult> {
  if (!params.headers.has("anthropic-version")) {
    params.headers.set("anthropic-version", "2023-06-01");
  }
  const response = await fetch(versionedUrl(params.baseUrl, "v1", "messages"), {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      system: params.system,
      messages: [{ role: "user", content: params.prompt }],
      max_tokens: params.maxTokens,
    }),
  });
  const data = await parseJsonResponse(response);
  const text = readAnthropicText(data);
  return text ? { ok: true, text } : { ok: false, error: formatHttpError(response, data) };
}

async function requestGemini(params: {
  baseUrl: string;
  model: string;
  headers: Headers;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<MemoryInferencerResult> {
  const response = await fetch(
    versionedUrl(params.baseUrl, "v1beta", `models/${encodeURIComponent(params.model)}:generateContent`),
    {
      method: "POST",
      headers: params.headers,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.system }] },
        contents: [{ role: "user", parts: [{ text: params.prompt }] }],
        generationConfig: { maxOutputTokens: params.maxTokens, temperature: 0 },
      }),
    },
  );
  const data = await parseJsonResponse(response);
  const text = readGeminiText(data);
  return text ? { ok: true, text } : { ok: false, error: formatHttpError(response, data) };
}

async function requestOllama(params: {
  baseUrl: string;
  model: string;
  headers: Headers;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<MemoryInferencerResult> {
  const response = await fetch(nativeUrl(params.baseUrl, "api/chat"), {
    method: "POST",
    headers: params.headers,
    body: JSON.stringify({
      model: params.model,
      stream: false,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.prompt },
      ],
      options: {
        temperature: 0,
        num_predict: params.maxTokens,
      },
    }),
  });
  const data = await parseJsonResponse(response);
  const text = readOllamaText(data);
  return text ? { ok: true, text } : { ok: false, error: formatHttpError(response, data) };
}

function versionedUrl(baseUrl: string, version: string, leaf: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const versionMarker = `/${version}`;
  if (normalized.endsWith(versionMarker)) {
    return `${normalized}/${leaf.replace(/^\/+/, "")}`;
  }
  return `${normalized}${versionMarker}/${leaf.replace(/^\/+/, "")}`;
}

function nativeUrl(baseUrl: string, leaf: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${leaf.replace(/^\/+/, "")}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatHttpError(response: Response, payload: unknown): string {
  if (response.ok) {
    return "Provider returned no text";
  }
  if (typeof payload === "string" && payload.trim()) {
    return `${response.status} ${response.statusText}: ${payload.trim()}`;
  }
  if (payload && typeof payload === "object") {
    const message =
      readNestedString(payload, ["error", "message"]) ||
      readNestedString(payload, ["message"]) ||
      readNestedString(payload, ["error"]);
    if (message) {
      return `${response.status} ${response.statusText}: ${message}`;
    }
  }
  return `${response.status} ${response.statusText}`.trim();
}

function readOpenAiChatText(payload: unknown): string {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const choices = data && Array.isArray(data.choices)
    ? data.choices
    : [];
  return choices
    .map((choice: unknown) => {
      if (!choice || typeof choice !== "object") {
        return "";
      }
      const candidate = choice as Record<string, unknown>;
      const message = candidate.message;
      if (message && typeof message === "object") {
        return readMessageContent((message as Record<string, unknown>).content);
      }
      return typeof candidate.text === "string" ? candidate.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readOpenAiResponsesText(payload: unknown): string {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (data && typeof data.output_text === "string") {
    return data.output_text.trim();
  }
  const output = data && Array.isArray(data.output)
    ? data.output
    : [];
  return output
    .flatMap((item: unknown) => {
      const candidate = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      if (!candidate || !Array.isArray(candidate.content)) {
        return [];
      }
      return candidate.content as unknown[];
    })
    .map((part: unknown) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const candidate = part as Record<string, unknown>;
      if (typeof candidate.text === "string") {
        return candidate.text.trim();
      }
      return typeof candidate.output_text === "string" ? candidate.output_text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readAnthropicText(payload: unknown): string {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const content = data && Array.isArray(data.content)
    ? data.content
    : [];
  return content
    .map((part: unknown) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const candidate = part as Record<string, unknown>;
      return typeof candidate.text === "string" ? candidate.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readGeminiText(payload: unknown): string {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const candidates =
    data && Array.isArray(data.candidates)
      ? data.candidates
      : [];
  return candidates
    .flatMap((candidate: unknown) => {
      const candidateObject =
        candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : null;
      if (!candidateObject) {
        return [];
      }
      const content =
        candidateObject.content && typeof candidateObject.content === "object"
          ? (candidateObject.content as Record<string, unknown>)
          : null;
      if (!content || !Array.isArray(content.parts)) {
        return [];
      }
      return content.parts as unknown[];
    })
    .map((part: unknown) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const candidate = part as Record<string, unknown>;
      return typeof candidate.text === "string" ? candidate.text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readOllamaText(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const data = payload as Record<string, unknown>;
    const message = data.message;
    if (
      message &&
      typeof message === "object" &&
      typeof (message as Record<string, unknown>).content === "string"
    ) {
      return ((message as Record<string, unknown>).content as string).trim();
    }
    if (typeof data.response === "string") {
      return data.response.trim();
    }
  }
  return "";
}

function readMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text.trim();
      }
      if ("type" in part && part.type === "text" && typeof part.text === "string") {
        return part.text.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readNestedString(value: unknown, path: string[]): string {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return "";
    }
    current = current[segment as keyof typeof current];
  }
  return typeof current === "string" ? current.trim() : "";
}

function estimateTokenBudget(maxChars: number | undefined): number {
  return Math.max(64, Math.ceil((maxChars ?? 600) / 4));
}
