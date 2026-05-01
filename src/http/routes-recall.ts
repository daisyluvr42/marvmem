import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./server.js";
import { bindAuthorizedContext, json, readBody } from "./server.js";

export async function handleRecallRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  path: string,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  const body = (await readBody(req)) as Record<string, unknown>;
  const context = bindAuthorizedContext(ctx.projectId, body.context);

  // POST /v1/recall
  if (path === "/v1/recall") {
    const inspect = body.inspect === true;
    if (inspect) {
      const result = await ctx.platform.inspectRecall({
        context: context as any,
        message: (body.message as string) ?? "",
        recentMessages: body.recentMessages as string[] | undefined,
        toolContext: body.toolContext as string | undefined,
        maxChars: body.maxChars as number | undefined,
        inspect: true,
      });
      json(res, 200, result);
    } else {
      const result = await ctx.platform.buildRecall({
        context: context as any,
        message: (body.message as string) ?? "",
        recentMessages: body.recentMessages as string[] | undefined,
        toolContext: body.toolContext as string | undefined,
        maxChars: body.maxChars as number | undefined,
      });
      json(res, 200, result);
    }
    return;
  }

  // POST /v1/turns/capture
  if (path === "/v1/turns/capture") {
    const result = await ctx.platform.captureTurn({
      context: context as any,
      userMessage: (body.userMessage as string) ?? "",
      assistantMessage: body.assistantMessage as string | undefined,
      recentMessages: body.recentMessages as string[] | undefined,
      toolContext: body.toolContext as string | undefined,
      taskTitle: body.taskTitle as string | undefined,
    });
    json(res, 200, {
      proposals: result.proposals.length,
      stored: result.stored.length,
      taskEntries: result.taskEntries?.length ?? 0,
    });
    return;
  }

  json(res, 404, { error: "Not found" });
}
