import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./server.js";
import { bindAuthorizedContext, json, readBody } from "./server.js";

export async function handleBridgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  path: string,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  if (!ctx.bridges) {
    json(res, 404, { error: "No bridges configured" });
    return;
  }

  // Parse path: /v1/bridge/{adapter}/{action}
  const match = path.match(/^\/v1\/bridge\/([^/]+)\/(import|export|sync)$/);
  if (!match) {
    json(res, 404, { error: "Invalid bridge path" });
    return;
  }

  const adapterName = match[1]!;
  const action = match[2]! as "import" | "export" | "sync";

  const adapter = ctx.bridges.get(adapterName);
  if (!adapter) {
    json(res, 404, { error: `Unknown bridge adapter: ${adapterName}` });
    return;
  }

  const body = (await readBody(req)) as Record<string, unknown>;
  const context = bindAuthorizedContext(ctx.projectId, body.context);
  const bridgeContext = {
    context: context as any,
    sourceRoot: body.sourceRoot as string | undefined,
  };

  if (action === "import") {
    const result = await adapter.import({ bridge: bridgeContext });
    json(res, 200, result);
    return;
  }

  if (action === "export") {
    const result = await adapter.export({ bridge: bridgeContext });
    json(res, 200, result);
    return;
  }

  if (action === "sync") {
    const direction = (body.direction as string) ?? "import";
    if (direction !== "import" && direction !== "export") {
      json(res, 400, { error: "direction must be 'import' or 'export'" });
      return;
    }
    const result = await adapter.sync({ bridge: bridgeContext, direction });
    json(res, 200, result);
    return;
  }

  json(res, 404, { error: "Not found" });
}
