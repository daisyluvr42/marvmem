import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformMemoryService } from "../platform/types.js";
import type { BridgeRegistry } from "../bridge/base.js";
import type { InspectEventStore } from "../inspect/types.js";
import { ProjectStore } from "../auth/project.js";
import { isValidApiKeyFormat } from "../auth/keys.js";
import type { AgentInstallOptions } from "../agents/manager.js";
import { handleMemoryRoutes } from "./routes-memory.js";
import { handleRecallRoutes } from "./routes-recall.js";
import { handleBridgeRoutes } from "./routes-bridge.js";
import { handleProjectRoutes } from "./routes-project.js";
import { handleConsoleRoutes } from "./routes-console.js";
import { handleAgentRoutes } from "./routes-agents.js";

// ---------------------------------------------------------------------------
// Server types
// ---------------------------------------------------------------------------

export type MarvMemServerOptions = {
  platform: PlatformMemoryService;
  projects: ProjectStore;
  bridges?: BridgeRegistry;
  events?: InspectEventStore;
  port?: number;
  host?: string;
  /** Path to the console static assets directory. Defaults to src/console/ */
  consolePath?: string;
  agents?: Pick<AgentInstallOptions, "home" | "storagePath" | "mcpPath">;
};

export type RequestContext = {
  platform: PlatformMemoryService;
  projects: ProjectStore;
  projectId: string;
  bridges?: BridgeRegistry;
  events?: InspectEventStore;
  agents?: Pick<AgentInstallOptions, "home" | "storagePath" | "mcpPath">;
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createMarvMemServer(options: MarvMemServerOptions) {
  const port = options.port ?? 3377;
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    // Health check (no auth required)
    if (pathname === "/v1/health" && req.method === "GET") {
      json(res, 200, { status: "ok", version: "0.1.0" });
      return;
    }

    // Console static files (no auth required)
    if (pathname === "/console" || pathname.startsWith("/console/")) {
      serveConsole(req, res, pathname, options.consolePath);
      return;
    }

    // Auth
    const apiKey = extractApiKey(req);
    if (!apiKey || !isValidApiKeyFormat(apiKey)) {
      json(res, 401, { error: "Missing or invalid API key" });
      return;
    }

    const project = options.projects.resolveKey(apiKey);
    if (!project) {
      json(res, 401, { error: "Invalid API key" });
      return;
    }

    const ctx: RequestContext = {
      platform: options.platform,
      projects: options.projects,
      projectId: project.id,
      bridges: options.bridges,
      events: options.events,
      agents: options.agents,
    };

    try {
      // Route dispatch
      if (pathname === "/v1/me/project" && req.method === "GET") {
        await handleProjectRoutes(req, res, ctx);
      } else if (pathname.startsWith("/v1/memories")) {
        await handleMemoryRoutes(req, res, ctx, pathname, url);
      } else if (pathname === "/v1/recall" || pathname === "/v1/turns/capture") {
        await handleRecallRoutes(req, res, ctx, pathname);
      } else if (pathname.startsWith("/v1/bridge/")) {
        await handleBridgeRoutes(req, res, ctx, pathname);
      } else if (pathname.startsWith("/v1/agents/")) {
        await handleAgentRoutes(req, res, ctx, pathname);
      } else if (pathname === "/v1/stats" || pathname === "/v1/events" || pathname.startsWith("/v1/inspect/")) {
        await handleConsoleRoutes(req, res, ctx, pathname, url);
      } else {
        json(res, 404, { error: "Not found" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  });

  return {
    server,
    listen() {
      return new Promise<void>((resolve) => {
        server.listen(port, host, () => resolve());
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    get address() {
      return `http://${host}:${port}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractApiKey(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function bindAuthorizedContext(projectId: string, value: unknown): Record<string, unknown> {
  const bodyContext =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...bodyContext,
    projectId,
  };
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Console static file server
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function resolveConsolePath(customPath?: string): string {
  if (customPath) return customPath;
  // Default: resolve relative to this file's directory → ../console/
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(thisDir, "..", "console");
  } catch {
    return path.resolve("src", "console");
  }
}

function serveConsole(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  customPath?: string,
): void {
  const baseDir = resolveConsolePath(customPath);

  // Strip /console prefix
  let relative = pathname.replace(/^\/console\/?/, "") || "index.html";
  if (relative === "") relative = "index.html";

  const filePath = path.join(baseDir, relative);

  // Security: prevent path traversal
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback: serve index.html for unknown routes
      const indexPath = path.join(baseDir, "index.html");
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content);
        return;
      }
      res.writeHead(404);
      res.end("Console not found. Ensure src/console/index.html exists.");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(500);
    res.end("Internal server error");
  }
}
