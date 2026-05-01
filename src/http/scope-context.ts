import { AGENT_IDS } from "../agents/manager.js";
import type { MemoryContext } from "../platform/types.js";

export function memoryContextFromQuery(projectId: string, url: URL): MemoryContext {
  const scope = url.searchParams.get("scope")?.trim();
  const view = url.searchParams.get("view")?.trim();

  if (scope?.startsWith("agent:")) {
    const agentId = scope.slice("agent:".length).trim();
    return agentId ? { projectId, agentId } : { projectId };
  }

  if (scope === "shared" || scope === "all" || view === "shared" || view === "all") {
    return { projectId, agentIds: [...AGENT_IDS] };
  }

  return { projectId };
}

export function mergeBodyContext(base: MemoryContext, value: unknown): MemoryContext {
  const bodyContext =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...base,
    ...bodyContext,
    projectId: base.projectId,
  } as MemoryContext;
}
