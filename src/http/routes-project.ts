import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestContext } from "./server.js";
import { json } from "./server.js";

export async function handleProjectRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const project = ctx.projects.get(ctx.projectId);
  if (!project) {
    json(res, 404, { error: "Project not found" });
    return;
  }

  json(res, 200, {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
  });
}
