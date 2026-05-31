import type { MarvMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import { createMemoryRuntime, type MemoryRuntime } from "../runtime/index.js";

type JsonRpcId = string | number | null;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"] as const;
const SERVER_INSTRUCTIONS =
  "Use memory_context with action='recall' and no scopeType/scopeId when continuity or prior decisions matter, so MarvMem can search shared memory across agents. " +
  "Use memory_record with action='write' for durable user preferences, facts, or explicit remember requests. " +
  "Use memory_session with action='commit' when the host agent has already distilled a session. " +
  "Use memory_task with action='append' or action='window' for longer task-focused work.";

export type MemoryToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutatesMemory?: boolean;
  execute(args: Record<string, unknown>): Promise<unknown>;
};

export function createMemoryToolSet(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
  onMemoryChanged?: () => Promise<void>;
}): MemoryToolDefinition[] {
  const runtime =
    params.runtime ??
    createMemoryRuntime({
      memory: params.memory,
      defaultScopes: params.defaultScopes,
    });

  return [
    {
      name: "memory_record",
      description: "Search, fetch, list, write, update, or delete long-term memory records.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["search", "get", "list", "write", "update", "delete"] },
          id: { type: "string" },
          query: { type: "string" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          content: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          confidence: { type: "number" },
          importance: { type: "number" },
          source: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true },
          limit: { type: "number" },
          maxResults: { type: "number" },
          minScore: { type: "number" },
        },
        required: ["action"],
      },
      mutatesMemory: true,
      execute: async (args) => {
        const action = expectString(args.action, "action");
        if (action === "search") {
          return {
            hits: await params.memory.search(expectString(args.query, "query"), {
              scopes: parseReadScopeArgs(args),
              maxResults: expectNumber(args.maxResults),
              minScore: expectNumber(args.minScore),
            }),
          };
        }
        if (action === "get") {
          return { record: await params.memory.get(expectString(args.id, "id")) };
        }
        if (action === "list") {
          return {
            records: await params.memory.list({
              scopes: parseReadScopeArgs(args),
              limit: expectNumber(args.limit),
            }),
          };
        }
        if (action === "write") {
          const scope = requireScope(args, params.defaultScopes);
          return {
            record: await params.memory.remember({
              scope,
              kind: optionalString(args.kind) ?? "note",
              content: expectString(args.content, "content"),
              summary: optionalString(args.summary),
              confidence: expectNumber(args.confidence),
              importance: expectNumber(args.importance),
              source: optionalString(args.source),
              tags: Array.isArray(args.tags)
                ? args.tags.filter((entry): entry is string => typeof entry === "string")
                : undefined,
              metadata: asRecord(args.metadata) ?? undefined,
            }),
          };
        }
        if (action === "update") {
          const id = expectString(args.id, "id");
          const scope = requireDestructiveScope(args, params.defaultScopes);
          const existing = await params.memory.get(id);
          if (!existing || !sameScope(existing.scope, scope)) {
            return { record: null, updated: false };
          }
          const patch: Record<string, unknown> = {};
          if (args.content !== undefined) patch.content = args.content;
          if (args.kind !== undefined) patch.kind = args.kind;
          if (args.summary !== undefined) patch.summary = args.summary;
          if (args.confidence !== undefined) patch.confidence = args.confidence;
          if (args.importance !== undefined) patch.importance = args.importance;
          if (args.source !== undefined) patch.source = args.source;
          if (args.tags !== undefined) patch.tags = args.tags;
          if (args.metadata !== undefined) patch.metadata = asRecord(args.metadata);
          const record = await params.memory.update(id, patch);
          return { record, updated: record !== null };
        }
        if (action === "delete") {
          const id = expectString(args.id, "id");
          const scope = requireDestructiveScope(args, params.defaultScopes);
          const existing = await params.memory.get(id);
          if (!existing || !sameScope(existing.scope, scope)) {
            return { deleted: false };
          }
          return { deleted: await params.memory.forget(id) };
        }
        throw new Error("action must be search, get, list, write, update, or delete");
      },
    },
    {
      name: "memory_context",
      description: "Build prompt-ready recall context or run the configured retrieval stack.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["recall", "retrieve"] },
          message: { type: "string" },
          query: { type: "string" },
          recentMessages: { type: "array", items: { type: "string" } },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxResults: { type: "number" },
          minScore: { type: "number" },
          maxChars: { type: "number" },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const scopes = parseReadScopeArgs(args);
        if (action === "recall") {
          return await runtime.buildRecallContext({
            userMessage: expectString(args.message, "message"),
            recentMessages: Array.isArray(args.recentMessages)
              ? args.recentMessages.filter((entry): entry is string => typeof entry === "string")
              : undefined,
            scopes,
            maxChars: expectNumber(args.maxChars),
          });
        }
        if (action === "retrieve") {
          return await params.memory.retrieval.recall(expectString(args.query, "query"), {
            scopes,
            maxResults: expectNumber(args.maxResults),
            minScore: expectNumber(args.minScore),
            maxChars: expectNumber(args.maxChars),
          });
        }
        throw new Error("action must be recall or retrieve");
      },
    },
    {
      name: "memory_active",
      description: "Read or distill active context and active experience for a scope.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["get", "distill"] },
          kind: { type: "string" },
          content: { type: "string" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["action"],
      },
      mutatesMemory: true,
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const scope = requireScope(args, params.defaultScopes);
        if (action === "get") {
          return {
            context: await params.memory.active.read("context", scope),
            experience: await params.memory.active.read("experience", scope),
          };
        }
        if (action === "distill") {
          const kind = expectString(args.kind, "kind");
          const content = expectString(args.content, "content");
          if (kind === "context") {
            return {
              document: await params.memory.active.distillContext({
                scope,
                sessionSummary: content,
                maxChars: expectNumber(args.maxChars),
              }),
            };
          }
          if (kind === "experience") {
            return {
              document: await params.memory.active.distillExperience({
                scope,
                newData: content,
                maxChars: expectNumber(args.maxChars),
              }),
            };
          }
          throw new Error("kind must be 'context' or 'experience'");
        }
        throw new Error("action must be get or distill");
      },
    },
    {
      name: "memory_session",
      description: "Commit a host-distilled session summary. The host agent supplies the summary; MarvMem only stores and updates it.",
      mutatesMemory: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["commit"] },
          agent: { type: "string" },
          sessionId: { type: "string" },
          taskId: { type: "string" },
          title: { type: "string" },
          cwd: { type: "string" },
          timestamp: { type: "string" },
          messageCount: { type: "number" },
          rollingSummary: { type: "string" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          entries: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                role: { type: "string" },
                content: { type: "string" },
                summary: { type: "string" },
                tokenCount: { type: "number" },
                metadata: { type: "object", additionalProperties: true },
              },
              required: ["role", "content"],
            },
          },
          durableMemories: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                content: { type: "string" },
                kind: { type: "string" },
                summary: { type: "string" },
                scopeType: { type: "string" },
                scopeId: { type: "string" },
                confidence: { type: "number" },
                importance: { type: "number" },
                source: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                metadata: { type: "object", additionalProperties: true },
              },
              required: ["content"],
            },
          },
        },
        required: ["action", "agent", "sessionId", "rollingSummary"],
      },
      execute: async (args) => {
        const action = expectString(args.action, "action");
        if (action !== "commit") {
          throw new Error("action must be commit");
        }
        const agent = expectString(args.agent, "agent");
        const sessionId = expectString(args.sessionId, "sessionId");
        const rollingSummary = expectString(args.rollingSummary, "rollingSummary");
        const taskId = optionalString(args.taskId) ?? `${agent}:${sessionId}`;
        const scope = parseScopeArgs(args, params.defaultScopes)?.[0];
        if (!scope) {
          throw new Error("scopeType and scopeId are required when no default scope is configured");
        }
        let task = await params.memory.task.get(taskId);
        if (!task) {
          task = await params.memory.task.create({
            taskId,
            scope,
            title: optionalString(args.title) ?? `${agent} session ${sessionId}`,
            status: "completed",
          });
        }

        const existingRecord = await findSessionMemoryRecord(params.memory, scope, sessionId, taskId);
        const existingMetadata = asRecord(existingRecord?.metadata) ?? {};
        const previousMessageCount = expectNumber(existingMetadata.messageCount) ?? 0;
        const messageCount = expectNumber(args.messageCount);
        const entries = parseSessionCommitEntries(args.entries);
        const shouldAppendEntries =
          entries.length > 0 &&
          (messageCount === undefined || messageCount > previousMessageCount || existingRecord === null);
        const appendedEntries = [];
        if (shouldAppendEntries) {
          for (const entry of entries) {
            const appended = await params.memory.task.appendEntry({
              taskId,
              role: entry.role,
              content: entry.content,
              summary: entry.summary,
              tokenCount: entry.tokenCount,
              metadata: entry.metadata,
            });
            if (appended) {
              appendedEntries.push(appended);
            }
          }
          await params.memory.task.markEntriesSummarized(
            taskId,
            appendedEntries.map((entry) => entry.id),
            rollingSummary,
          );
        }

        const state = await params.memory.task.setRollingSummary(taskId, rollingSummary);
        const nowIso = new Date().toISOString();
        const source = existingRecord?.source || `${agent}_session_commit`;
        const sessionMetadata = compactRecord({
          ...existingMetadata,
          agent,
          sessionId,
          taskId,
          cwd: optionalString(args.cwd) ?? optionalString(existingMetadata.cwd),
          timestamp: optionalString(args.timestamp) ?? optionalString(existingMetadata.timestamp),
          messageCount: Math.max(
            previousMessageCount,
            messageCount ?? previousMessageCount + appendedEntries.length,
          ),
          lastCommittedAt: nowIso,
          commitSource: "host",
          resumeCount:
            (expectNumber(existingMetadata.resumeCount) ?? 0) +
            (existingRecord && appendedEntries.length > 0 ? 1 : 0),
        });
        const sessionPatch = {
          scope,
          kind: "note",
          content: buildSessionCommitContent({
            agent,
            sessionId,
            taskId,
            cwd: optionalString(args.cwd) ?? optionalString(existingMetadata.cwd),
            timestamp: optionalString(args.timestamp) ?? optionalString(existingMetadata.timestamp),
            rollingSummary,
          }),
          summary: clampText(`${agent} session ${sessionId}: ${rollingSummary}`, 220),
          confidence: 0.9,
          importance: 0.6,
          source,
          tags: [agent, "session"],
          metadata: sessionMetadata,
        };
        const sessionRecord = existingRecord
          ? await params.memory.update(existingRecord.id, sessionPatch)
          : await params.memory.remember(sessionPatch);

        const durableRecords = [];
        for (const memory of parseDurableMemories(args.durableMemories)) {
          durableRecords.push(
            await params.memory.remember({
              scope: memory.scope ?? scope,
              kind: memory.kind,
              content: memory.content,
              summary: memory.summary,
              confidence: memory.confidence,
              importance: memory.importance,
              source: memory.source ?? `${agent}_session_commit`,
              tags: memory.tags,
              metadata: compactRecord({
                ...memory.metadata,
                sessionId,
                taskId,
                cwd: optionalString(args.cwd),
                origin: "host_session_commit",
              }),
            }),
          );
        }

        return {
          task,
          state,
          sessionRecord,
          appendedEntries: appendedEntries.length,
          durableRecords,
        };
      },
    },
    {
      name: "memory_task",
      description: "Append entries to task context or build a prompt-ready task window.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["append", "window"] },
          taskId: { type: "string" },
          title: { type: "string" },
          role: { type: "string" },
          content: { type: "string" },
          message: { type: "string" },
          toolContext: { type: "string" },
          maxChars: { type: "number" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
        },
        required: ["action", "taskId"],
      },
      mutatesMemory: true,
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const taskId = expectString(args.taskId, "taskId");
        if (action === "append") {
          let task = await params.memory.task.get(taskId);
          if (!task) {
            const scope = parseScopeArgs(args, params.defaultScopes)?.[0];
            if (!scope) {
              throw new Error("scopeType and scopeId are required when creating a task");
            }
            task = await params.memory.task.create({
              taskId,
              scope,
              title: optionalString(args.title) ?? taskId,
            });
          }
          const entry = await params.memory.task.appendEntry({
            taskId,
            role: expectString(args.role, "role") as "user" | "assistant" | "system" | "tool",
            content: expectString(args.content, "content"),
          });
          return { task, entry };
        }
        if (action === "window") {
          return await params.memory.task.buildWindow({
            taskId,
            currentQuery: expectString(args.message, "message"),
            toolContext: optionalString(args.toolContext),
            maxChars: expectNumber(args.maxChars),
          });
        }
        throw new Error("action must be append or window");
      },
    },
    {
      name: "memory_maintenance",
      description: "Run maintenance operations for active experience.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["calibrate", "rebuild"] },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["action"],
      },
      mutatesMemory: true,
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const scope = requireScope(args, params.defaultScopes);
        if (action === "calibrate") {
          return {
            result: await params.memory.maintenance.calibrateExperience({
              scope,
              maxChars: expectNumber(args.maxChars),
            }),
          };
        }
        if (action === "rebuild") {
          return {
            result: await params.memory.maintenance.rebuildExperience({
              scope,
              maxChars: expectNumber(args.maxChars),
            }),
          };
        }
        throw new Error("action must be calibrate or rebuild");
      },
    },
  ];
}

export function createMemoryMcpHandler(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
  onMemoryChanged?: () => Promise<void>;
}) {
  const tools = createMemoryToolSet(params);
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    async handleRequest(payload: unknown) {
      const request = asRecord(payload);
      if (!request) {
        return rpcError(null, -32600, "Invalid Request");
      }
      const id = normalizeId(request.id);
      const method = typeof request.method === "string" ? request.method : "";

      if (method === "initialize") {
        const paramsRecord = asRecord(request.params);
        const requestedVersion = typeof paramsRecord?.protocolVersion === "string"
          ? paramsRecord.protocolVersion
          : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
          requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
        )
          ? requestedVersion
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion,
          serverInfo: { name: "marvmem", version: "0.1.0" },
          capabilities: { tools: {} },
          instructions: SERVER_INSTRUCTIONS,
        });
      }

      if (method === "notifications/initialized") {
        // Acknowledge but no response needed for notifications
        return undefined;
      }

      if (method === "ping") {
        return rpcResult(id, {});
      }

      if (method === "tools/list") {
        return rpcResult(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      }

      if (method === "tools/call") {
        const paramsRecord = asRecord(request.params);
        const name = typeof paramsRecord?.name === "string" ? paramsRecord.name : "";
        const args = asRecord(paramsRecord?.arguments) ?? {};
        const tool = toolMap.get(name);
        if (!tool) {
          return rpcError(id, -32601, `Unknown tool: ${name}`);
        }
        try {
          const result = await tool.execute(args);
          if (tool.mutatesMemory) {
            await params.onMemoryChanged?.();
          }
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
            isError: false,
          });
        } catch (error) {
          return rpcError(id, -32602, error instanceof Error ? error.message : String(error));
        }
      }

      return rpcError(id, -32601, `Unknown method: ${method}`);
    },
  };
}

type SessionCommitEntry = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  summary?: string;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
};

type SessionCommitDurableMemory = {
  scope?: MemoryScope;
  kind: string;
  content: string;
  summary?: string;
  confidence?: number;
  importance?: number;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

async function findSessionMemoryRecord(
  memory: MarvMem,
  scope: MemoryScope,
  sessionId: string,
  taskId: string,
): Promise<MemoryRecord | null> {
  const records = await memory.list({ scopes: [scope] });
  return (
    records.find((record) => {
      const metadata = asRecord(record.metadata) ?? {};
      return (
        optionalString(metadata.sessionId) === sessionId &&
        optionalString(metadata.taskId) === taskId &&
        (record.tags.includes("session") || record.source.includes("_session_"))
      );
    }) ?? null
  );
}

function parseSessionCommitEntries(value: unknown): SessionCommitEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("entries must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`entries[${index}] must be an object`);
    }
    const role = expectString(record.role, `entries[${index}].role`);
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
      throw new Error(`entries[${index}].role must be user, assistant, system, or tool`);
    }
    return {
      role,
      content: expectString(record.content, `entries[${index}].content`),
      summary: optionalString(record.summary),
      tokenCount: expectNumber(record.tokenCount),
      metadata: asRecord(record.metadata) ?? undefined,
    };
  });
}

function parseDurableMemories(value: unknown): SessionCommitDurableMemory[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("durableMemories must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`durableMemories[${index}] must be an object`);
    }
    const scopeType = optionalString(record.scopeType);
    const scopeId = optionalString(record.scopeId);
    const scope = scopeType || scopeId
      ? {
          type: expectString(record.scopeType, `durableMemories[${index}].scopeType`) as MemoryScope["type"],
          id: expectString(record.scopeId, `durableMemories[${index}].scopeId`),
        }
      : undefined;
    return {
      scope,
      kind: optionalString(record.kind) ?? "note",
      content: expectString(record.content, `durableMemories[${index}].content`),
      summary: optionalString(record.summary),
      confidence: expectNumber(record.confidence),
      importance: expectNumber(record.importance),
      source: optionalString(record.source),
      tags: Array.isArray(record.tags)
        ? record.tags.filter((tag): tag is string => typeof tag === "string" && Boolean(tag.trim()))
        : undefined,
      metadata: asRecord(record.metadata) ?? undefined,
    };
  });
}

function buildSessionCommitContent(input: {
  agent: string;
  sessionId: string;
  taskId: string;
  cwd?: string;
  timestamp?: string;
  rollingSummary: string;
}): string {
  return [
    `${input.agent} session: ${input.sessionId}`,
    input.timestamp ? `Started: ${input.timestamp}` : "",
    input.cwd ? `Working directory: ${input.cwd}` : "",
    `Task id: ${input.taskId}`,
    "",
    "Session summary:",
    input.rollingSummary,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function clampText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd();
}

function requireScope(args: Record<string, unknown>, fallback?: MemoryScope[]): MemoryScope {
  const scope = parseScopeArgs(args, fallback)?.[0];
  if (!scope) {
    throw new Error("scopeType and scopeId are required when no default scope is configured");
  }
  return scope;
}

function requireDestructiveScope(args: Record<string, unknown>, fallback?: MemoryScope[]): MemoryScope {
  const requested = parseReadScopeArgs(args)?.[0];
  const defaultScope = fallback?.[0];
  if (defaultScope && requested && !sameScope(requested, defaultScope)) {
    throw new Error("scopeType and scopeId must match the configured default scope");
  }
  const scope = requested ?? defaultScope;
  if (!scope) {
    throw new Error("scopeType and scopeId are required for update/delete when no default scope is configured");
  }
  return scope;
}

function parseScopeArgs(
  args: Record<string, unknown>,
  fallback?: MemoryScope[],
): MemoryScope[] | undefined {
  return parseReadScopeArgs(args) ?? fallback;
}

function parseReadScopeArgs(args: Record<string, unknown>): MemoryScope[] | undefined {
  const scopeType = optionalString(args.scopeType);
  const scopeId = optionalString(args.scopeId);
  if (scopeType && scopeId) {
    return [{ type: scopeType as MemoryScope["type"], id: scopeId }];
  }
  return undefined;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return left.type === right.type && left.id === right.id;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expectNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeId(value: unknown): JsonRpcId {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }
  return null;
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}
