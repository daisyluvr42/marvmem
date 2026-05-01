import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./server.js";
import { json, readBody } from "./server.js";
import { memoryContextFromQuery, mergeBodyContext } from "./scope-context.js";

/**
 * Routes for the Console control plane:
 * GET  /v1/stats         — dashboard overview
 * GET  /v1/events        — paginated event log
 * POST /v1/inspect/recall — full recall inspection with layers
 */
export async function handleConsoleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  path: string,
  url: URL,
): Promise<void> {
  // GET /v1/stats
  if (path === "/v1/stats" && req.method === "GET") {
    const memories = await ctx.platform.listMemories({
      context: memoryContextFromQuery(ctx.projectId, url),
      limit: 10_000,
    });

    // Aggregate by kind
    const kindCounts: Record<string, number> = {};
    const scopeCounts: Record<string, number> = {};
    const sourceCounts: Record<string, number> = {};
    let newest: string | null = null;
    let oldest: string | null = null;

    for (const record of memories) {
      kindCounts[record.kind] = (kindCounts[record.kind] ?? 0) + 1;
      const scopeKey = `${record.scope.type}:${record.scope.id}`;
      scopeCounts[scopeKey] = (scopeCounts[scopeKey] ?? 0) + 1;
      sourceCounts[record.source] = (sourceCounts[record.source] ?? 0) + 1;

      if (!newest || record.updatedAt > newest) newest = record.updatedAt;
      if (!oldest || record.createdAt < oldest) oldest = record.createdAt;
    }

    json(res, 200, {
      totalMemories: memories.length,
      kinds: kindCounts,
      scopes: scopeCounts,
      sources: sourceCounts,
      newestMemory: newest,
      oldestMemory: oldest,
      recentEvents: (ctx.events?.recent({ limit: 10 }) ?? []).length,
    });
    return;
  }

  // GET /v1/events (enhanced with pagination & type filter)
  if (path === "/v1/events" && req.method === "GET") {
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const type = url.searchParams.get("type") ?? undefined;
    const events = ctx.events?.recent({
      limit: Math.min(limit, 200),
      type: type as any,
    }) ?? [];
    json(res, 200, { events, total: events.length });
    return;
  }

  // POST /v1/inspect/recall
  if (path === "/v1/inspect/recall" && req.method === "POST") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const context = mergeBodyContext(memoryContextFromQuery(ctx.projectId, url), body.context);

    const result = await ctx.platform.inspectRecall({
      context,
      message: (body.message as string) ?? "",
      recentMessages: body.recentMessages as string[] | undefined,
      toolContext: body.toolContext as string | undefined,
      maxChars: body.maxChars as number | undefined,
      inspect: true,
    });

    json(res, 200, result);
    return;
  }

  json(res, 404, { error: "Not found" });
}
