import type { MarvMem } from "../core/memory.js";
import type { MemoryScope } from "../core/types.js";
import { createMemoryToolSet, type MemoryToolDefinition } from "../mcp/handler.js";
import { createMemoryRuntime, type MemoryRuntime } from "../runtime/index.js";

export type GenericMemoryAdapter = {
  tools: MemoryToolDefinition[];
  beforePrompt(input: {
    userMessage: string;
    recentMessages?: string[];
    scopes?: MemoryScope[];
  }): Promise<{
    systemHint: string;
    injectedContext: string;
  }>;
  afterTurn(input: {
    userMessage: string;
    assistantMessage?: string;
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
      });
    },
  };
}

