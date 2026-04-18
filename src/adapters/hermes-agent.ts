import type { MarvMem } from "../core/memory.js";
import type { MemoryScope } from "../core/types.js";
import type { MemoryRuntime } from "../runtime/index.js";
import { createGenericMemoryAdapter } from "./base.js";

export type HermesAgentMemoryAdapter = ReturnType<typeof createHermesAgentMemoryAdapter>;

export function createHermesAgentMemoryAdapter(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
}) {
  return createGenericMemoryAdapter(params);
}

