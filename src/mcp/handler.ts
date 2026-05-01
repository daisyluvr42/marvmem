import type { MarvMem } from "../core/memory.js";
import type { MemoryScope } from "../core/types.js";
import { createMemoryRuntime, type MemoryRuntime } from "../runtime/index.js";

type JsonRpcId = string | number | null;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"] as const;
const SERVER_INSTRUCTIONS =
  "Use memory_recall when continuity or prior decisions matter. " +
  "Use memory_write for durable user preferences, facts, or explicit remember requests. " +
  "Use memory_task_append and memory_task_window for longer task-focused work.";

export type MemoryToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
};

export function createMemoryToolSet(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
}): MemoryToolDefinition[] {
  const runtime =
    params.runtime ??
    createMemoryRuntime({
      memory: params.memory,
      defaultScopes: params.defaultScopes,
    });

  return [
    {
      name: "memory_search",
      description: "Search long-term memory records by query.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxResults: { type: "number" },
          minScore: { type: "number" },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = expectString(args.query, "query");
        const scopes = parseScopeArgs(args, params.defaultScopes);
        return {
          hits: await params.memory.search(query, {
            scopes,
            maxResults: expectNumber(args.maxResults),
            minScore: expectNumber(args.minScore),
          }),
        };
      },
    },
    {
      name: "memory_get",
      description: "Fetch one memory record by id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
      execute: async (args) => {
        const id = expectString(args.id, "id");
        return {
          record: await params.memory.get(id),
        };
      },
    },
    {
      name: "memory_list",
      description: "List memory records, optionally filtered by scope.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          limit: { type: "number" },
        },
      },
      execute: async (args) => {
        const scopes = parseScopeArgs(args, params.defaultScopes);
        return {
          records: await params.memory.list({
            scopes,
            limit: expectNumber(args.limit),
          }),
        };
      },
    },
    {
      name: "memory_write",
      description: "Persist a durable memory record. Automatically merges with similar existing memories.",
      inputSchema: {
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
          tags: {
            type: "array",
            items: { type: "string" },
          },
          metadata: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["content", "scopeType", "scopeId"],
      },
      execute: async (args) => {
        const scope = requireScope(args);
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
      },
    },
    {
      name: "memory_update",
      description: "Update an existing memory record by id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          kind: { type: "string" },
          summary: { type: "string" },
          confidence: { type: "number" },
          importance: { type: "number" },
          source: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
          },
          metadata: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["id"],
      },
      execute: async (args) => {
        const id = expectString(args.id, "id");
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
      },
    },
    {
      name: "memory_delete",
      description: "Delete a memory record by id. Irreversible.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
      execute: async (args) => {
        const id = expectString(args.id, "id");
        const deleted = await params.memory.forget(id);
        return { deleted };
      },
    },
    {
      name: "memory_recall",
      description: "Recall prompt-ready memory context for a new turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          message: { type: "string" },
          recentMessages: {
            type: "array",
            items: { type: "string" },
          },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["message"],
      },
      execute: async (args) => {
        const message = expectString(args.message, "message");
        const scopes = parseScopeArgs(args, params.defaultScopes);
        return await runtime.buildRecallContext({
          userMessage: message,
          recentMessages: Array.isArray(args.recentMessages)
            ? args.recentMessages.filter((entry): entry is string => typeof entry === "string")
            : undefined,
          scopes,
          maxChars: expectNumber(args.maxChars),
        });
      },
    },
    {
      name: "memory_retrieve",
      description: "Run the configured retrieval stack, including remote embeddings and optional QMD.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxResults: { type: "number" },
          minScore: { type: "number" },
          maxChars: { type: "number" },
        },
        required: ["query"],
      },
      execute: async (args) => {
        const query = expectString(args.query, "query");
        const scopes = parseScopeArgs(args, params.defaultScopes);
        return await params.memory.retrieval.recall(query, {
          scopes,
          maxResults: expectNumber(args.maxResults),
          minScore: expectNumber(args.minScore),
          maxChars: expectNumber(args.maxChars),
        });
      },
    },
    {
      name: "memory_active_get",
      description: "Read active context and active experience for a scope.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scopeType: { type: "string" },
          scopeId: { type: "string" },
        },
        required: ["scopeType", "scopeId"],
      },
      execute: async (args) => {
        const scope = requireScope(args);
        return {
          context: await params.memory.active.read("context", scope),
          experience: await params.memory.active.read("experience", scope),
        };
      },
    },
    {
      name: "memory_active_distill",
      description: "Distill active context or active experience for a scope.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string" },
          content: { type: "string" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["kind", "content", "scopeType", "scopeId"],
      },
      execute: async (args) => {
        const scope = requireScope(args);
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
      },
    },
    {
      name: "memory_task_append",
      description: "Append an entry into task context, creating the task when needed.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          role: { type: "string" },
          content: { type: "string" },
          scopeType: { type: "string" },
          scopeId: { type: "string" },
        },
        required: ["taskId", "role", "content"],
      },
      execute: async (args) => {
        const taskId = expectString(args.taskId, "taskId");
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
      },
    },
    {
      name: "memory_task_window",
      description: "Build a prompt-ready task context window.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          message: { type: "string" },
          toolContext: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["taskId", "message"],
      },
      execute: async (args) => {
        return await params.memory.task.buildWindow({
          taskId: expectString(args.taskId, "taskId"),
          currentQuery: expectString(args.message, "message"),
          toolContext: optionalString(args.toolContext),
          maxChars: expectNumber(args.maxChars),
        });
      },
    },
    {
      name: "memory_maintenance_calibrate",
      description: "Run experience calibration for a scope.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["scopeType", "scopeId"],
      },
      execute: async (args) => {
        return {
          result: await params.memory.maintenance.calibrateExperience({
            scope: requireScope(args),
            maxChars: expectNumber(args.maxChars),
          }),
        };
      },
    },
    {
      name: "memory_maintenance_rebuild",
      description: "Rebuild active experience from recent long-term memory fragments.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scopeType: { type: "string" },
          scopeId: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["scopeType", "scopeId"],
      },
      execute: async (args) => {
        return {
          result: await params.memory.maintenance.rebuildExperience({
            scope: requireScope(args),
            maxChars: expectNumber(args.maxChars),
          }),
        };
      },
    },
  ];
}

export function createMemoryMcpHandler(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
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

function requireScope(args: Record<string, unknown>): MemoryScope {
  const scopeType = expectString(args.scopeType, "scopeType") as MemoryScope["type"];
  const scopeId = expectString(args.scopeId, "scopeId");
  return { type: scopeType, id: scopeId };
}

function parseScopeArgs(
  args: Record<string, unknown>,
  fallback?: MemoryScope[],
): MemoryScope[] | undefined {
  const scopeType = optionalString(args.scopeType);
  const scopeId = optionalString(args.scopeId);
  if (scopeType && scopeId) {
    return [{ type: scopeType as MemoryScope["type"], id: scopeId }];
  }
  return fallback;
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
