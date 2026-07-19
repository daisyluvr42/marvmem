import type { MarvMem } from "../core/memory.js";
import {
  MEMORY_SCOPE_TYPES,
  parseMemoryScopeType,
  type MemoryRecord,
  type MemoryScope,
} from "../core/types.js";
import { createMemoryRuntime, type MemoryRuntime } from "../runtime/index.js";

type JsonRpcId = string | number | null;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"] as const;
const MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ACTIVE_CONTEXT_MAX_CHARS = 400;
const ACTIVE_EXPERIENCE_MAX_CHARS = 800;
const SCOPE_TYPE_SCHEMA = { type: "string", enum: [...MEMORY_SCOPE_TYPES] };
const SERVER_INSTRUCTIONS =
  "Use memory_context with action='recall' and no scopeType/scopeId when continuity or prior decisions matter, so MarvMem can search shared memory across agents. " +
  "Use memory_record with action='write' for durable user preferences, facts, or explicit remember requests; when no configured scope exists, MarvMem derives agent:<clientInfo.name> during initialize. " +
  "Use memory_session with action='commit' when the host agent has already distilled a session; include activeContext/activeExperience when available, and follow maintenanceRequest if returned. " +
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
  getDefaultScopes?: () => MemoryScope[] | undefined;
  onMemoryChanged?: () => Promise<void>;
}): MemoryToolDefinition[] {
  const runtime =
    params.runtime ??
    createMemoryRuntime({
      memory: params.memory,
      defaultScopes: resolveDefaultScopes(params),
    });

  return [
    {
      name: "memory_record",
      description: "Search, fetch, list, write, update, or delete long-term memory records.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["search", "get", "list", "write", "update", "delete", "restore"] },
          id: { type: "string" },
          query: { type: "string" },
          scopeType: SCOPE_TYPE_SCHEMA,
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
          includeDeleted: { type: "boolean" },
          includeDocuments: { type: "boolean" },
          reason: { type: "string" },
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
          return {
            record: await params.memory.get(expectString(args.id, "id"), {
              includeDeleted: args.includeDeleted === true,
              includeDocuments: args.includeDocuments !== false,
            }),
          };
        }
        if (action === "list") {
          return {
            records: await params.memory.list({
              scopes: parseReadScopeArgs(args),
              limit: expectNumber(args.limit),
              includeDeleted: args.includeDeleted === true,
              includeDocuments: args.includeDocuments === true,
            }),
          };
        }
        if (action === "write") {
          const scope = requireScope(args, resolveDefaultScopes(params));
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
          const scope = requireDestructiveScope(args, resolveDefaultScopes(params));
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
          const scope = requireDestructiveScope(args, resolveDefaultScopes(params));
          const existing = await params.memory.get(id);
          if (!existing || !sameScope(existing.scope, scope)) {
            return { deleted: false };
          }
          return {
            deleted: await params.memory.forget(id, {
              deletedBy: `mcp:${scope.type}:${scope.id}`,
              reason: optionalString(args.reason),
            }),
          };
        }
        if (action === "restore") {
          const id = expectString(args.id, "id");
          const scope = requireDestructiveScope(args, resolveDefaultScopes(params));
          const existing = await params.memory.get(id, { includeDeleted: true });
          if (!existing || !sameScope(existing.scope, scope)) {
            return { record: null, restored: false };
          }
          const record = await params.memory.restore(id);
          return { record, restored: record !== null };
        }
        throw new Error("action must be search, get, list, write, update, delete, or restore");
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
          scopeType: SCOPE_TYPE_SCHEMA,
          scopeId: { type: "string" },
          maxResults: { type: "number" },
          minScore: { type: "number" },
          maxChars: { type: "number" },
          verbose: { type: "boolean" },
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
          scopeType: SCOPE_TYPE_SCHEMA,
          scopeId: { type: "string" },
          maxChars: { type: "number" },
        },
        required: ["action"],
      },
      mutatesMemory: true,
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const scope = requireScope(args, resolveDefaultScopes(params));
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
      description: "Commit a host-distilled session summary and active memory. MarvMem stores it and returns a maintenance request when deeper governance is due.",
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
          activeContext: { type: "string" },
          activeExperience: { type: "string" },
          governanceReport: { type: "object", additionalProperties: true },
          recordActions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                action: { type: "string", enum: ["update", "supersede", "softDelete", "restore"] },
                id: { type: "string" },
                winnerId: { type: "string" },
                scopeType: SCOPE_TYPE_SCHEMA,
                scopeId: { type: "string" },
                content: { type: "string" },
                summary: { type: "string" },
                reason: { type: "string" },
              },
              required: ["action", "id", "scopeType", "scopeId"],
            },
          },
          scopeType: SCOPE_TYPE_SCHEMA,
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
                scopeType: SCOPE_TYPE_SCHEMA,
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
        const activeContext = optionalString(args.activeContext);
        const activeExperience = optionalString(args.activeExperience);
        const governanceReport = asRecord(args.governanceReport) ?? undefined;
        const taskId = optionalString(args.taskId) ?? `${agent}:${sessionId}`;
        const scope = parseScopeArgs(args, resolveDefaultScopes(params))?.[0];
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

        const sourceRecordIds = [
          sessionRecord?.id,
          ...durableRecords.map((record) => record.id),
        ].filter((id): id is string => typeof id === "string");
        const governanceMetadata = compactRecord({
          lastLightGovernedAt: nowIso,
          lastGovernedBy: agent,
          sessionId,
          taskId,
          sourceRecordIds,
          governanceReport,
        });
        const active = {
          context: await writeActiveDocument({
            memory: params.memory,
            kind: "context",
            scope,
            content: activeContext ?? rollingSummary,
            metadata: governanceMetadata,
            maxChars: ACTIVE_CONTEXT_MAX_CHARS,
          }),
          experience: activeExperience
            ? await writeActiveDocument({
                memory: params.memory,
                kind: "experience",
                scope,
                content: activeExperience,
                metadata: governanceMetadata,
                maxChars: ACTIVE_EXPERIENCE_MAX_CHARS,
              })
            : undefined,
        };
        const maintenanceRequest = await buildMaintenanceRequestIfDue(params.memory, scope, nowIso);

        return {
          task,
          state,
          sessionRecord,
          appendedEntries: appendedEntries.length,
          durableRecords,
          active,
          maintenanceRequest,
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
          scopeType: SCOPE_TYPE_SCHEMA,
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
            const scope = parseScopeArgs(args, resolveDefaultScopes(params))?.[0];
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
      description: "Prepare or apply host-mediated active memory maintenance, or run inferencer-backed experience maintenance.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["prepare", "apply", "calibrate", "rebuild"] },
          agent: { type: "string" },
          scopeType: SCOPE_TYPE_SCHEMA,
          scopeId: { type: "string" },
          maxChars: { type: "number" },
          activeContext: { type: "string" },
          activeExperience: { type: "string" },
          governanceReport: { type: "object", additionalProperties: true },
        },
        required: ["action"],
      },
      mutatesMemory: true,
      execute: async (args) => {
        const action = expectString(args.action, "action");
        const scope = requireScope(args, resolveDefaultScopes(params));
        if (action === "prepare") {
          return {
            request: await buildMaintenanceRequest(params.memory, scope, new Date().toISOString()),
          };
        }
        if (action === "apply") {
          const activeContext = optionalString(args.activeContext);
          const activeExperience = optionalString(args.activeExperience);
          const recordActions = parseMaintenanceRecordActions(args.recordActions);
          if (!activeContext && !activeExperience && recordActions.length === 0) {
            throw new Error("activeContext, activeExperience, or recordActions is required for apply");
          }
          const nowIso = new Date().toISOString();
          const agent = optionalString(args.agent) ?? "host";
          const governanceMetadata = compactRecord({
            lastLightGovernedAt: nowIso,
            lastDeepGovernedAt: nowIso,
            lastGovernedBy: agent,
            governanceReport: asRecord(args.governanceReport) ?? undefined,
          });
          const actionResults = [];
          for (const recordAction of recordActions) {
            actionResults.push(
              await applyMaintenanceRecordAction(params.memory, recordAction, {
                agent,
                nowIso,
              }),
            );
          }
          return {
            recordActions: actionResults,
            context: activeContext
              ? await writeActiveDocument({
                  memory: params.memory,
                  kind: "context",
                  scope,
                  content: activeContext,
                  metadata: governanceMetadata,
                  maxChars: ACTIVE_CONTEXT_MAX_CHARS,
                })
              : await params.memory.active.read("context", scope),
            experience: activeExperience
              ? await writeActiveDocument({
                  memory: params.memory,
                  kind: "experience",
                  scope,
                  content: activeExperience,
                  metadata: governanceMetadata,
                  maxChars: ACTIVE_EXPERIENCE_MAX_CHARS,
                })
              : await params.memory.active.read("experience", scope),
          };
        }
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
        throw new Error("action must be prepare, apply, calibrate, or rebuild");
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
  let inferredDefaultScopes = params.defaultScopes;
  const tools = createMemoryToolSet({
    ...params,
    getDefaultScopes: () => inferredDefaultScopes,
  });
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
        if (!params.defaultScopes?.length) {
          const clientInfo = asRecord(paramsRecord?.clientInfo);
          const clientName = optionalString(clientInfo?.name);
          const clientId = clientName ? normalizeClientAgentId(clientName) : undefined;
          if (clientId) {
            inferredDefaultScopes = [{ type: "agent", id: clientId }];
          }
        }
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
          const output = compactToolResult(name, result, args);
          const text =
            name === "memory_context" && args.verbose !== true
              ? JSON.stringify(output)
              : JSON.stringify(output, null, 2);
          return rpcResult(id, {
            content: [
              {
                type: "text",
                text,
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

function compactToolResult(
  name: string,
  result: unknown,
  args: Record<string, unknown>,
): unknown {
  if (name !== "memory_context" || args.verbose === true) {
    return result;
  }
  const recall = asRecord(result);
  if (!recall) {
    return result;
  }
  return compactRecord({
    query: typeof recall.query === "string" ? clampText(recall.query, 1_200) : recall.query,
    injectedContext: recall.injectedContext,
    hits: Array.isArray(recall.hits)
      ? recall.hits.map((hit) => compactSearchHit(hit))
      : undefined,
  });
}

function compactSearchHit(value: unknown): unknown {
  const hit = asRecord(value);
  if (!hit) {
    return value;
  }
  const record = asRecord(hit.record);
  return compactRecord({
    id: record?.id ?? hit.id,
    scope: record?.scope ?? hit.scope,
    kind: record?.kind ?? hit.kind,
    summary: typeof (record?.summary ?? hit.summary) === "string"
      ? clampText(String(record?.summary ?? hit.summary), 220)
      : undefined,
    source: record?.source ?? hit.source,
    score: hit.score,
    snippet: typeof hit.snippet === "string" ? clampText(hit.snippet, 240) : undefined,
  });
}

function compactEvidence(value: unknown): unknown {
  const evidence = asRecord(value);
  if (!evidence) {
    return value;
  }
  return compactRecord({
    ...evidence,
    metadata: compactMetadata(evidence.metadata),
  });
}

function compactMetadata(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const json = JSON.stringify(value);
  if (json.length <= 1_000) {
    return value;
  }
  const metadata = asRecord(value);
  if (!metadata) {
    return { truncated: true };
  }
  return compactRecord({
    sessionId: metadata.sessionId,
    taskId: metadata.taskId,
    cwd: metadata.cwd,
    timestamp: metadata.timestamp,
    lastImportedAt: metadata.lastImportedAt,
    lastCommittedAt: metadata.lastCommittedAt,
    truncated: true,
  });
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

type ActiveDocumentKind = "context" | "experience";

type MaintenanceRecordAction =
  | {
      action: "update";
      id: string;
      scope: MemoryScope;
      content: string;
      summary?: string;
      reason?: string;
    }
  | {
      action: "supersede";
      id: string;
      winnerId: string;
      scope: MemoryScope;
      reason?: string;
    }
  | {
      action: "softDelete";
      id: string;
      scope: MemoryScope;
      reason?: string;
    }
  | {
      action: "restore";
      id: string;
      scope: MemoryScope;
      reason?: string;
    };

async function writeActiveDocument(input: {
  memory: MarvMem;
  kind: ActiveDocumentKind;
  scope: MemoryScope;
  content: string;
  metadata: Record<string, unknown>;
  maxChars: number;
}) {
  const current = await input.memory.active.read(input.kind, input.scope);
  return await input.memory.active.write({
    kind: input.kind,
    scope: input.scope,
    content: clampText(input.content, input.maxChars),
    metadata: compactRecord({
      ...(asRecord(current?.metadata) ?? {}),
      ...input.metadata,
    }),
  });
}

async function applyMaintenanceRecordAction(
  memory: MarvMem,
  action: MaintenanceRecordAction,
  governance: { agent: string; nowIso: string },
) {
  const existing = await memory.get(action.id, { includeDeleted: true });
  if (!existing || !sameScope(existing.scope, action.scope)) {
    return { action: action.action, id: action.id, applied: false, reason: "record_not_found_or_scope_mismatch" };
  }
  if (action.action === "update") {
    const record = await memory.update(action.id, {
      content: action.content,
      summary: action.summary,
      metadata: compactRecord({
        ...(existing.metadata ?? {}),
        lastGovernedAt: governance.nowIso,
        lastGovernedBy: governance.agent,
        governanceReason: action.reason,
      }),
    });
    return { action: action.action, id: action.id, applied: record !== null, record };
  }
  if (action.action === "softDelete") {
    const applied = await memory.forget(action.id, {
      deletedBy: `maintenance:${governance.agent}`,
      reason: action.reason,
    });
    return { action: action.action, id: action.id, applied };
  }
  if (action.action === "restore") {
    const record = await memory.restore(action.id);
    return { action: action.action, id: action.id, applied: record !== null, record };
  }
  const winner = await memory.get(action.winnerId);
  if (!winner) {
    return { action: action.action, id: action.id, applied: false, reason: "winner_not_found" };
  }
  await memory.update(action.id, {
    metadata: compactRecord({
      ...(existing.metadata ?? {}),
      lastGovernedAt: governance.nowIso,
      lastGovernedBy: governance.agent,
      governanceReason: action.reason,
    }),
  });
  const applied = await memory.supersede(action.id, action.winnerId);
  return { action: action.action, id: action.id, winnerId: action.winnerId, applied };
}

async function buildMaintenanceRequestIfDue(
  memory: MarvMem,
  scope: MemoryScope,
  nowIso: string,
) {
  const [context, experience, conflicts] = await Promise.all([
    memory.active.read("context", scope),
    memory.active.read("experience", scope),
    findCrossScopeConflictCandidates(memory, scope),
  ]);
  if (
    !isMaintenanceDue([context?.metadata, experience?.metadata], nowIso) &&
    !conflicts.some((candidate) => candidate.similarity >= 0.65)
  ) {
    return undefined;
  }
  return await buildMaintenanceRequest(memory, scope, nowIso, conflicts);
}

async function buildMaintenanceRequest(
  memory: MarvMem,
  scope: MemoryScope,
  nowIso: string,
  providedConflicts?: Awaited<ReturnType<typeof findCrossScopeConflictCandidates>>,
) {
  const [context, experience, listedRecords] = await Promise.all([
    memory.active.read("context", scope),
    memory.active.read("experience", scope),
    memory.list({ scopes: [scope], limit: 36 }),
  ]);
  const records = listedRecords.filter((record) => !isSessionPalaceRecord(record)).slice(0, 12);
  const conflictCandidates = providedConflicts ?? await findCrossScopeConflictCandidates(memory, scope);
  return {
    kind: "active_memory_maintenance",
    scope,
    generatedAt: nowIso,
    intervalHours: 24,
    active: { context, experience },
    palaceRecords: records.map((record) => ({
      id: record.id,
      kind: record.kind,
      content: clampText(record.content, 700),
      summary: record.summary,
      source: record.source,
      tags: record.tags,
      metadata: compactMetadata(record.metadata),
      updatedAt: record.updatedAt,
    })),
    conflictCandidates,
    instructions: [
      "Use the host LLM to lightly deduplicate, decay stale details, and correct active memory against durable palace records.",
      "Review conflictCandidates across scopes; apply explicit update, supersede, softDelete, or restore recordActions when evidence is sufficient.",
      "Keep activeContext compact and current; keep activeExperience as reusable lessons only.",
      "Return memory_maintenance.apply with recordActions, activeContext, activeExperience, and a short governanceReport.",
    ],
  };
}

async function findCrossScopeConflictCandidates(memory: MarvMem, scope: MemoryScope) {
  const records = (await memory.list({ scopes: [scope], limit: 8 }))
    .filter((record) => !isSessionPalaceRecord(record))
    .filter((record) => isComparableMemoryKind(record.kind));
  const pairs = [];
  const seen = new Set<string>();
  for (const left of records) {
    const hits = await memory.search(left.summary ?? left.content, {
      maxResults: 8,
      minScore: 0.4,
    });
    for (const hit of hits) {
      const right = hit.record;
      if (
        right.id === left.id ||
        sameScope(left.scope, right.scope) ||
        isSessionPalaceRecord(right) ||
        !areComparableMemoryKinds(left.kind, right.kind) ||
        right.content.trim() === left.content.trim()
      ) {
        continue;
      }
      const key = [left.id, right.id].sort().join(":");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pairs.push({
        left: compactPalaceRecord(left),
        right: compactPalaceRecord(right),
        similarity: hit.score,
        reasons: [
          "cross_scope",
          left.kind === right.kind ? "same_kind" : "comparable_fact_kind",
        ],
      });
      if (pairs.length >= 6) {
        return pairs;
      }
    }
  }
  return pairs;
}

function compactPalaceRecord(record: MemoryRecord) {
  return {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    content: clampText(record.content, 500),
    summary: record.summary,
    source: record.source,
    tags: record.tags,
    updatedAt: record.updatedAt,
  };
}

function isSessionPalaceRecord(record: MemoryRecord): boolean {
  return record.kind === "note" && (record.tags.includes("session") || record.source.includes("_session_"));
}

function isComparableMemoryKind(kind: string): boolean {
  return ["fact", "decision", "identity", "preference", "lesson", "repo_fact"].includes(kind);
}

function areComparableMemoryKinds(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const factKinds = new Set(["fact", "identity", "repo_fact"]);
  return factKinds.has(left) && factKinds.has(right);
}

function isMaintenanceDue(metadataList: Array<unknown>, nowIso: string): boolean {
  const now = Date.parse(nowIso);
  const lastDeepAt = metadataList
    .map((metadata) => optionalString(asRecord(metadata)?.lastDeepGovernedAt))
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  return lastDeepAt === undefined || now - lastDeepAt >= MAINTENANCE_INTERVAL_MS;
}

async function findSessionMemoryRecord(
  memory: MarvMem,
  scope: MemoryScope,
  sessionId: string,
  taskId: string,
): Promise<MemoryRecord | null> {
  return await memory.findSessionRecord(scope, sessionId, taskId);
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
          type: parseMemoryScopeType(
            expectString(record.scopeType, `durableMemories[${index}].scopeType`),
            `durableMemories[${index}].scopeType`,
          ),
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

function parseMaintenanceRecordActions(value: unknown): MaintenanceRecordAction[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("recordActions must be an array");
  }
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      throw new Error(`recordActions[${index}] must be an object`);
    }
    const action = expectString(record.action, `recordActions[${index}].action`);
    const scope = {
      type: parseMemoryScopeType(
        expectString(record.scopeType, `recordActions[${index}].scopeType`),
        `recordActions[${index}].scopeType`,
      ),
      id: expectString(record.scopeId, `recordActions[${index}].scopeId`),
    };
    const base = {
      id: expectString(record.id, `recordActions[${index}].id`),
      scope,
      reason: optionalString(record.reason),
    };
    if (action === "update") {
      return {
        ...base,
        action,
        content: expectString(record.content, `recordActions[${index}].content`),
        summary: optionalString(record.summary),
      };
    }
    if (action === "supersede") {
      return {
        ...base,
        action,
        winnerId: expectString(record.winnerId, `recordActions[${index}].winnerId`),
      };
    }
    if (action === "softDelete" || action === "restore") {
      return { ...base, action };
    }
    throw new Error(`recordActions[${index}].action must be update, supersede, softDelete, or restore`);
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

function resolveDefaultScopes(params: {
  defaultScopes?: MemoryScope[];
  getDefaultScopes?: () => MemoryScope[] | undefined;
}): MemoryScope[] | undefined {
  return params.getDefaultScopes?.() ?? params.defaultScopes;
}

function requireDestructiveScope(args: Record<string, unknown>, fallback?: MemoryScope[]): MemoryScope {
  const requested = parseReadScopeArgs(args)?.[0];
  const defaultScope = fallback?.[0];
  if (defaultScope && requested && !sameScope(requested, defaultScope)) {
    throw new Error("scopeType and scopeId must match the configured default scope");
  }
  const scope = requested ?? defaultScope;
  if (!scope) {
    throw new Error("scopeType and scopeId are required for update/delete/restore when no default scope is configured");
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
  if (!scopeType && !scopeId) {
    return undefined;
  }
  if (!scopeType || !scopeId) {
    throw new Error("scopeType and scopeId must be provided together");
  }
  return [{ type: parseMemoryScopeType(scopeType), id: scopeId }];
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

function normalizeClientAgentId(name: string): string | undefined {
  const normalized = name.toLowerCase().trim();
  const aliases: Array<[RegExp, string]> = [
    [/\bcodex\b/u, "codex"],
    [/\bclaude\b/u, "claude"],
    [/\bcursor\b/u, "cursor"],
    [/\bworkbuddy\b/u, "workbuddy"],
    [/\b(?:github\s+)?copilot\b/u, "copilot"],
    [/\bantigravity\b/u, "antigravity"],
    [/\btrae\b/u, "trae"],
  ];
  for (const [pattern, id] of aliases) {
    if (pattern.test(normalized)) {
      return id;
    }
  }
  const slug = normalized
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug || undefined;
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
