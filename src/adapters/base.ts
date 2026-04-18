import type { MarvMem } from "../core/memory.js";
import { normalizeScope, scopeKey, type MemoryScope } from "../core/types.js";
import { createMemoryToolSet, type MemoryToolDefinition } from "../mcp/handler.js";
import {
  createMemoryRuntime,
  inferMemoryProposals,
  type MemoryRuntime,
} from "../runtime/index.js";

const MAX_BUFFERED_RECENT_MESSAGES = 24;
const MAX_SESSION_FLUSH_CHARS = 12_000;

export type MemoryAdapterPromptInput = {
  userMessage: string;
  recentMessages?: string[];
  scopes?: MemoryScope[];
  maxChars?: number;
  taskId?: string;
  toolContext?: string;
};

export type MemoryAdapterTurnInput = {
  userMessage: string;
  assistantMessage?: string;
  scopes?: MemoryScope[];
  taskId?: string;
  taskTitle?: string;
  toolContext?: string;
};

export type GenericMemoryAdapter = {
  tools: MemoryToolDefinition[];
  beforePrompt(input: MemoryAdapterPromptInput): Promise<{
    systemHint: string;
    injectedContext: string;
  }>;
  afterTurn(input: MemoryAdapterTurnInput): Promise<void>;
};

export type SessionMemoryAdapter = {
  tools: MemoryToolDefinition[];
  beforePrompt(input: MemoryAdapterPromptInput): Promise<{
    systemHint: string;
    injectedContext: string;
  }>;
  afterTurn(input: MemoryAdapterTurnInput): Promise<void>;
  flushSession(input?: {
    scopes?: MemoryScope[];
  }): Promise<void>;
};

export function createGenericMemoryAdapter(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
}): GenericMemoryAdapter {
  const runtime =
    params.runtime ??
    createMemoryRuntime({
      memory: params.memory,
      defaultScopes: params.defaultScopes,
    });

  return {
    tools: createMemoryToolSet({
      memory: params.memory,
      runtime,
      defaultScopes: params.defaultScopes,
    }),
    async beforePrompt(input) {
      const recall = await runtime.buildRecallContext({
        userMessage: input.userMessage,
        recentMessages: input.recentMessages,
        scopes: input.scopes ?? params.defaultScopes,
        maxChars: input.maxChars,
        taskId: input.taskId,
        toolContext: input.toolContext,
      });
      return {
        systemHint: runtime.buildSystemHint(),
        injectedContext: recall.injectedContext,
      };
    },
    async afterTurn(input) {
      await runtime.captureTurn({
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        scopes: input.scopes ?? params.defaultScopes,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        toolContext: input.toolContext,
      });
    },
  };
}

export function createSessionMemoryAdapter(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
}): SessionMemoryAdapter {
  const runtime =
    params.runtime ??
    createMemoryRuntime({
      memory: params.memory,
      defaultScopes: params.defaultScopes,
    });
  const buffers = new Map<string, SessionBuffer>();

  return {
    tools: createMemoryToolSet({
      memory: params.memory,
      runtime,
      defaultScopes: params.defaultScopes,
    }),
    async beforePrompt(input) {
      const scopes = resolveScopes(input.scopes, params.defaultScopes);
      const recall = await runtime.buildRecallContext({
        userMessage: input.userMessage,
        recentMessages: mergeRecentMessages(input.recentMessages, scopes, buffers),
        scopes,
        maxChars: input.maxChars,
        taskId: input.taskId ?? readBufferedTaskId(scopes, buffers),
        toolContext: input.toolContext ?? readBufferedToolContext(scopes, buffers),
      });
      return {
        systemHint: runtime.buildSystemHint(),
        injectedContext: recall.injectedContext,
      };
    },
    async afterTurn(input) {
      const scopes = resolveScopes(input.scopes, params.defaultScopes);
      if (scopes.length === 0) {
        return;
      }
      for (const scope of scopes) {
        const key = scopeKey(scope);
        const buffer = buffers.get(key) ?? createEmptyBuffer(scope);
        if (input.userMessage.trim()) {
          buffer.transcriptLines.push(`user: ${input.userMessage.trim()}`);
        }
        if (input.assistantMessage?.trim()) {
          buffer.transcriptLines.push(`assistant: ${input.assistantMessage.trim()}`);
        }
        if (input.taskId?.trim()) {
          buffer.lastTaskId = input.taskId.trim();
        }
        if (input.taskTitle?.trim()) {
          buffer.lastTaskTitle = input.taskTitle.trim();
        }
        if (input.toolContext?.trim()) {
          buffer.lastToolContext = input.toolContext.trim();
        }
        buffers.set(key, buffer);
      }
      await captureTurnLight({
        memory: params.memory,
        defaultScopes: params.defaultScopes,
        turn: input,
      });
    },
    async flushSession(input = {}) {
      const keys =
        input.scopes && input.scopes.length > 0
          ? resolveScopes(input.scopes, params.defaultScopes).map((scope) => scopeKey(scope))
          : [...buffers.keys()];
      for (const key of keys) {
        const buffer = buffers.get(key);
        if (!buffer) {
          continue;
        }
        const sessionSummary = buildSessionSummary(buffer);
        if (sessionSummary) {
          await params.memory.active.distillContext({
            scope: buffer.scope,
            sessionSummary,
          });
        }
        if (buffer.lastTaskId) {
          await params.memory.task.distillRollingSummary({
            taskId: buffer.lastTaskId,
          });
        }
        buffers.delete(key);
      }
    },
  };
}

type SessionBuffer = {
  scope: MemoryScope;
  transcriptLines: string[];
  lastTaskId?: string;
  lastTaskTitle?: string;
  lastToolContext?: string;
};

function createEmptyBuffer(scope: MemoryScope): SessionBuffer {
  return {
    scope,
    transcriptLines: [],
  };
}

function resolveScopes(scopes?: MemoryScope[], fallback?: MemoryScope[]): MemoryScope[] {
  return (scopes ?? fallback ?? []).map((scope) => normalizeScope(scope));
}

function mergeRecentMessages(
  explicit: string[] | undefined,
  scopes: MemoryScope[],
  buffers: Map<string, SessionBuffer>,
): string[] | undefined {
  const normalizedExplicit = explicit?.map((message) => message.trim()).filter(Boolean);
  if (normalizedExplicit && normalizedExplicit.length > 0) {
    return normalizedExplicit;
  }
  const buffered = scopes.flatMap((scope) => buffers.get(scopeKey(scope))?.transcriptLines ?? []);
  if (buffered.length === 0) {
    return undefined;
  }
  return buffered.slice(-MAX_BUFFERED_RECENT_MESSAGES);
}

function readBufferedTaskId(
  scopes: MemoryScope[],
  buffers: Map<string, SessionBuffer>,
): string | undefined {
  for (const scope of scopes) {
    const taskId = buffers.get(scopeKey(scope))?.lastTaskId;
    if (taskId) {
      return taskId;
    }
  }
  return undefined;
}

function readBufferedToolContext(
  scopes: MemoryScope[],
  buffers: Map<string, SessionBuffer>,
): string | undefined {
  for (const scope of scopes) {
    const toolContext = buffers.get(scopeKey(scope))?.lastToolContext;
    if (toolContext) {
      return toolContext;
    }
  }
  return undefined;
}

async function captureTurnLight(params: {
  memory: MarvMem;
  defaultScopes?: MemoryScope[];
  turn: MemoryAdapterTurnInput;
}): Promise<void> {
  const scopes = resolveScopes(params.turn.scopes, params.defaultScopes);
  const proposals = inferMemoryProposals({
    userMessage: params.turn.userMessage,
    assistantMessage: params.turn.assistantMessage,
    scopes,
    taskId: params.turn.taskId,
    taskTitle: params.turn.taskTitle,
    toolContext: params.turn.toolContext,
  });
  if (params.turn.taskId && scopes[0]) {
    const taskId = params.turn.taskId.trim();
    let task = await params.memory.task.get(taskId);
    if (!task) {
      task = await params.memory.task.create({
        taskId,
        scope: scopes[0],
        title: params.turn.taskTitle?.trim() || taskId,
      });
    }
    await params.memory.task.appendEntry({
      taskId: task.taskId,
      role: "user",
      content: params.turn.userMessage,
    });
    if (params.turn.assistantMessage?.trim()) {
      await params.memory.task.appendEntry({
        taskId: task.taskId,
        role: "assistant",
        content: params.turn.assistantMessage,
      });
    }
  }
  if (scopes.length === 0) {
    return;
  }
  for (const proposal of proposals) {
    const scope = proposal.scopes?.[0] ?? scopes[0];
    if (!scope) {
      continue;
    }
    await params.memory.remember({
      scope,
      kind: proposal.kind,
      content: proposal.content,
      summary: proposal.summary,
      confidence: proposal.confidence,
      importance: proposal.importance,
      source: proposal.source,
      tags: proposal.tags,
      metadata: proposal.metadata,
    });
  }
}

function buildSessionSummary(buffer: SessionBuffer): string {
  const sections = [
    buffer.lastTaskTitle?.trim() ? `Task title:\n${buffer.lastTaskTitle.trim()}` : "",
    buffer.transcriptLines.length > 0
      ? `Session transcript:\n${buffer.transcriptLines.join("\n")}`
      : "",
    buffer.lastToolContext?.trim()
      ? `Latest tool context:\n${buffer.lastToolContext.trim()}`
      : "",
  ].filter(Boolean);
  const text = sections.join("\n\n").trim();
  if (text.length <= MAX_SESSION_FLUSH_CHARS) {
    return text;
  }
  return text.slice(-MAX_SESSION_FLUSH_CHARS).trimStart();
}
