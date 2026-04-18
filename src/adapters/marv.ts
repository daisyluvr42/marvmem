import type { MarvMem } from "../core/memory.js";
import type { MemoryScope } from "../core/types.js";
import type { MemoryRuntime } from "../runtime/index.js";
import { createGenericMemoryAdapter } from "./base.js";

export type MarvMemoryAdapter = ReturnType<typeof createMarvMemoryAdapter>;

export function createMarvMemoryAdapter(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
}) {
  return createGenericMemoryAdapter(params);
}

