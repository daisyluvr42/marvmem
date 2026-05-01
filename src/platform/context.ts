import type { MemoryScope } from "../core/types.js";
import type { MemoryContext, ResolvedScopes } from "./types.js";

// ---------------------------------------------------------------------------
// Task namespacing
// ---------------------------------------------------------------------------

/**
 * Derive a canonical task key that prevents cross-project and cross-repo
 * collisions in the existing task store.
 *
 * Rule: `[projectId, repoId ?? "_", taskId].join("::")`
 */
export function canonicalTaskId(context: MemoryContext): string | undefined {
  if (!context.taskId) {
    return undefined;
  }
  return [context.projectId, context.repoId ?? "_", context.taskId].join("::");
}

export function canonicalRepoId(context: MemoryContext): string | undefined {
  if (!context.repoId) {
    return undefined;
  }
  return [context.projectId, context.repoId].join("::");
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Translate a product-level `MemoryContext` into core-level scopes.
 *
 * Returns:
 * - `writeScope` — single primary scope for persisting durable records.
 *   Prefers repo when available, otherwise project.
 * - `recallScopes` — ordered scope list for search, highest weight first.
 *
 * Each field in MemoryContext maps to a dedicated scope type:
 *   projectId → "project",  repoId → "repo",     userId → "user",
 *   agentId   → "agent",    sessionId → "session", taskId → "task"
 */
export function resolveContextScopes(context: MemoryContext): ResolvedScopes {
  if (!context.projectId) {
    throw new Error("MemoryContext.projectId is required");
  }

  // --- Write scope ---
  const repoKey = canonicalRepoId(context);
  const writeScope: MemoryScope = repoKey
    ? { type: "repo", id: repoKey }
    : { type: "project", id: context.projectId };

  // --- Recall scopes (ordered by weight descending) ---
  const recallScopes: MemoryScope[] = [];

  const taskKey = canonicalTaskId(context);
  if (taskKey) {
    recallScopes.push({ type: "task", id: taskKey, weight: 1.15 });
  }

  if (repoKey) {
    recallScopes.push({ type: "repo", id: repoKey, weight: 1.1 });
  }

  recallScopes.push({ type: "project", id: context.projectId, weight: 1.08 });

  if (context.userId) {
    recallScopes.push({ type: "user", id: context.userId, weight: 1.05 });
  }

  for (const agentId of uniqueAgentIds(context)) {
    recallScopes.push({ type: "agent", id: agentId, weight: 1.0 });
  }

  if (context.sessionId) {
    recallScopes.push({ type: "session", id: context.sessionId, weight: 0.9 });
  }

  return { writeScope, recallScopes };
}

// ---------------------------------------------------------------------------
// Scope target filtering
// ---------------------------------------------------------------------------

type ScopeTargetKey = "project" | "repo" | "user" | "agent" | "session" | "task";

/**
 * Given a MemoryContext and an optional set of scope target keys, return the
 * subset of resolved scopes that match.  Used by `listMemories` to let callers
 * filter by specific scope dimensions.
 *
 * When `targets` is empty or undefined, returns the full recall scope list.
 */
export function filterScopesByTargets(
  context: MemoryContext,
  targets?: ScopeTargetKey[],
): MemoryScope[] {
  const { recallScopes } = resolveContextScopes(context);

  if (!targets || targets.length === 0) {
    return recallScopes;
  }

  const targetSet = new Set<string>(targets);
  return recallScopes.filter((scope) => targetSet.has(scope.type));
}

function uniqueAgentIds(context: MemoryContext): string[] {
  const ids = [context.agentId, ...(context.agentIds ?? [])]
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Project isolation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a memory record belongs to a given project context.
 *
 * A record "belongs to" a project if its scope matches any of the scopes
 * that would be generated from the context.  This covers:
 * - direct project scope
 * - repo scope (which is project-paired)
 * - user / agent / session / task scopes derived from the context
 */
export function recordBelongsToProject(
  record: { scope: MemoryScope },
  context: MemoryContext,
): boolean {
  const { recallScopes } = resolveContextScopes(context);
  const key = `${record.scope.type}:${record.scope.id}`.toLowerCase();
  return recallScopes.some(
    (scope) => `${scope.type}:${scope.id}`.toLowerCase() === key,
  );
}
