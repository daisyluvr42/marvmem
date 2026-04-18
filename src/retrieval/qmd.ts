import { spawn } from "node:child_process";
import type { MemoryQmdConfig } from "../system/types.js";
import type { RetrievalHit } from "./types.js";

type QmdQueryResult = {
  docid?: string;
  file?: string;
  snippet?: string;
  body?: string;
  score?: number;
};

export class QmdRetrievalBackend {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxSnippetChars: number;
  private collectionsEnsured = false;

  constructor(private readonly config: MemoryQmdConfig) {
    this.command = config.command?.trim() || "qmd";
    this.timeoutMs = Math.max(1_000, config.timeoutMs ?? 15_000);
    this.maxResults = Math.max(1, config.maxResults ?? 8);
    this.maxSnippetChars = Math.max(120, config.maxSnippetChars ?? 500);
  }

  async search(query: string, options?: { maxResults?: number; minScore?: number }): Promise<RetrievalHit[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }
    await this.ensureCollections();
    const limit = Math.min(Math.max(1, options?.maxResults ?? this.maxResults), this.maxResults);
    const collectionNames = (this.config.collections ?? [])
      .map((collection) => collection.name.trim())
      .filter(Boolean);
    if (collectionNames.length === 0) {
      return [];
    }
    const args = ["query", trimmed, "--json", "-n", String(limit), ...collectionNames.flatMap((name) => ["-c", name])];
    const result = await this.runQmd(args);
    const parsed = parseQmdQueryJson(result.stdout, result.stderr);
    const minScore = options?.minScore ?? 0;
    return parsed
      .map((entry) => ({
        source: "qmd" as const,
        score: typeof entry.score === "number" ? entry.score : 0,
        snippet: (entry.snippet ?? entry.body ?? "").slice(0, this.maxSnippetChars),
        path: entry.file ?? entry.docid,
      }))
      .filter((entry) => entry.snippet.trim() && entry.score >= minScore)
      .slice(0, limit);
  }

  private async ensureCollections(): Promise<void> {
    if (this.collectionsEnsured) {
      return;
    }
    for (const collection of this.config.collections ?? []) {
      const name = collection.name.trim();
      const collectionPath = collection.path.trim();
      if (!name || !collectionPath) {
        continue;
      }
      try {
        await this.runQmd([
          "collection",
          "add",
          collectionPath,
          "--name",
          name,
          "--mask",
          collection.pattern?.trim() || "**/*.md",
        ]);
      } catch (error) {
        const message = String(error).toLowerCase();
        if (!message.includes("already exists") && !message.includes("exists")) {
          throw error;
        }
      }
    }
    this.collectionsEnsured = true;
  }

  private async runQmd(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`qmd ${args.join(" ")} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`qmd ${args.join(" ")} failed (code ${code}): ${stderr || stdout}`));
      });
    });
  }
}

function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[] {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  if (!trimmedStdout) {
    if (!trimmedStderr || isNoResultsMarker(trimmedStderr)) {
      return [];
    }
    throw new Error(`qmd query returned invalid JSON: ${trimmedStderr}`);
  }
  if (isNoResultsMarker(trimmedStdout)) {
    return [];
  }
  const parsed = parseArray(trimmedStdout);
  if (parsed) {
    return parsed;
  }
  const extracted = extractFirstJsonArray(trimmedStdout);
  if (!extracted) {
    throw new Error("qmd query returned invalid JSON");
  }
  const fallback = parseArray(extracted);
  if (!fallback) {
    throw new Error("qmd query returned invalid JSON");
  }
  return fallback;
}

function parseArray(raw: string): QmdQueryResult[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QmdQueryResult[]) : null;
  } catch {
    return null;
  }
}

function isNoResultsMarker(raw: string): boolean {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .some((line) => line === "no results found" || line === "no results found.");
}

function extractFirstJsonArray(raw: string): string | null {
  const start = raw.indexOf("[");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (!char) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
}
