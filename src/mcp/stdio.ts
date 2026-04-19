import { homedir } from "node:os";
import { join } from "node:path";
import { createMarvMem, type MarvMem, type MarvMemOptions } from "../core/index.js";
import type { MemoryScope } from "../core/types.js";
import { createMemoryMcpHandler } from "./handler.js";

export type MemoryMcpStdioServerOptions = {
  memory?: MarvMem;
  defaultScopes?: MemoryScope[];
  storagePath?: string;
  retrieval?: MarvMemOptions["retrieval"];
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};

export function defaultMemoryMcpStoragePath(): string {
  return join(homedir(), ".marvmem", "memory.sqlite");
}

export async function runMemoryMcpStdioServer(
  options: MemoryMcpStdioServerOptions = {},
): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const memory =
    options.memory ??
    createMarvMem({
      storage: {
        backend: "sqlite",
        path: options.storagePath ?? defaultMemoryMcpStoragePath(),
      },
      retrieval: options.retrieval,
    });
  const handler = createMemoryMcpHandler({
    memory,
    defaultScopes: options.defaultScopes,
  });

  if ("setEncoding" in stdin && typeof stdin.setEncoding === "function") {
    stdin.setEncoding("utf8");
  }

  let buffer = "";
  let queue = Promise.resolve();

  stdin.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : String(chunk);
    queue = queue.then(async () => {
      await drainBufferedLines(false);
    });
  });

  stdin.on("end", () => {
    queue = queue.then(async () => {
      await drainBufferedLines(true);
    });
  });

  await new Promise<void>((resolve, reject) => {
    stdin.once("error", reject);
    stdin.once("end", () => {
      void queue.then(resolve, reject);
    });
  });

  async function drainBufferedLines(flush: boolean): Promise<void> {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await handleLine(line);
    }

    if (flush) {
      const tail = buffer.trim();
      buffer = "";
      if (tail) {
        await handleLine(tail);
      }
    }
  }

  async function handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[marvmem-mcp] ${message}\n`);
      stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })}\n`,
      );
      return;
    }

    try {
      const response = await handler.handleRequest(payload);
      if (response !== undefined) {
        stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[marvmem-mcp] ${message}\n`);
      stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        })}\n`,
      );
    }
  }
}
