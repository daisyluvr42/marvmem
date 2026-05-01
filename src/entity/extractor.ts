import type { MemoryInferencer } from "../system/types.js";
import type { EntityExtractor, ExtractedEntity } from "./types.js";

// ---------------------------------------------------------------------------
// Known technology / tool dictionaries
// ---------------------------------------------------------------------------

const KNOWN_TECH: Set<string> = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "kotlin", "swift",
  "react", "vue", "angular", "svelte", "next.js", "nextjs", "nuxt", "vite",
  "node.js", "nodejs", "deno", "bun",
  "postgresql", "mysql", "sqlite", "mongodb", "redis", "qdrant",
  "docker", "kubernetes", "terraform",
  "graphql", "rest", "grpc", "websocket",
  "tailwindcss", "css", "html",
  "supabase", "firebase", "aws", "gcp", "azure",
  "openai", "gemini", "claude", "anthropic",
  "langchain", "crewai", "vercel",
]);

const KNOWN_TOOLS: Set<string> = new Set([
  "pnpm", "npm", "yarn", "bun", "cargo", "pip", "poetry",
  "git", "github", "gitlab", "bitbucket",
  "vim", "neovim", "vscode", "cursor", "zed",
  "eslint", "prettier", "biome", "vitest", "jest",
  "docker", "make", "cmake",
]);

// ---------------------------------------------------------------------------
// Rule-based entity extractor (zero LLM dependency)
// ---------------------------------------------------------------------------

const MENTION_RE = /@(\w[\w.-]*\w|\w)/g;
const QUOTED_RE = /["""]([^"""]+?)["""]/g;
const PASCAL_CASE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

export class RuleBasedEntityExtractor implements EntityExtractor {
  async extract(text: string): Promise<ExtractedEntity[]> {
    const entities: Map<string, ExtractedEntity> = new Map();
    const lower = text.toLowerCase();

    // 1. Known tech names
    for (const tech of KNOWN_TECH) {
      if (lower.includes(tech)) {
        const key = tech.toLowerCase();
        if (!entities.has(key)) {
          entities.set(key, { name: tech, kind: "tech" });
        }
      }
    }

    // 2. Known tools
    for (const tool of KNOWN_TOOLS) {
      if (lower.includes(tool) && !entities.has(tool.toLowerCase())) {
        entities.set(tool.toLowerCase(), { name: tool, kind: "tool" });
      }
    }

    // 3. @mentions → person
    for (const match of text.matchAll(MENTION_RE)) {
      const name = match[1]!;
      const key = name.toLowerCase();
      if (!entities.has(key) && !KNOWN_TECH.has(key) && !KNOWN_TOOLS.has(key)) {
        entities.set(key, { name, kind: "person" });
      }
    }

    // 4. Quoted strings that look like project names
    for (const match of text.matchAll(QUOTED_RE)) {
      const name = match[1]!.trim();
      const key = name.toLowerCase();
      if (name.length >= 2 && name.length <= 40 && !entities.has(key)) {
        entities.set(key, { name, kind: "project" });
      }
    }

    // 5. PascalCase compound words (likely class/project names)
    for (const match of text.matchAll(PASCAL_CASE_RE)) {
      const name = match[1]!;
      const key = name.toLowerCase();
      if (!entities.has(key) && !KNOWN_TECH.has(key)) {
        entities.set(key, { name, kind: "tech" });
      }
    }

    return [...entities.values()];
  }
}

// ---------------------------------------------------------------------------
// LLM-based entity extractor
// ---------------------------------------------------------------------------

const NER_SYSTEM_PROMPT = `Extract named entities from the text. Return JSON array:
[{"name": "...", "kind": "person|project|tech|tool|org", "aliases": ["..."]}]
Only extract specific, meaningful entities. Skip generic terms. Maximum 8 entities.`;

export class LlmEntityExtractor implements EntityExtractor {
  private readonly inferencer: MemoryInferencer;
  private readonly fallback = new RuleBasedEntityExtractor();

  constructor(inferencer: MemoryInferencer) {
    this.inferencer = inferencer;
  }

  async extract(text: string): Promise<ExtractedEntity[]> {
    if (text.trim().length < 10) {
      return [];
    }

    const result = await this.inferencer({
      kind: "entity_extraction",
      system: NER_SYSTEM_PROMPT,
      prompt: text,
      maxChars: 2000,
    });

    if (!result.ok) {
      return this.fallback.extract(text);
    }

    try {
      const parsed = JSON.parse(extractJsonArray(result.text));
      if (!Array.isArray(parsed)) {
        return this.fallback.extract(text);
      }
      return parsed
        .filter(
          (item: Record<string, unknown>) =>
            typeof item.name === "string" && typeof item.kind === "string",
        )
        .map((item: Record<string, unknown>) => ({
          name: String(item.name),
          kind: String(item.kind) as ExtractedEntity["kind"],
          aliases: Array.isArray(item.aliases)
            ? (item.aliases as string[]).filter((a) => typeof a === "string")
            : undefined,
        }));
    } catch {
      return this.fallback.extract(text);
    }
  }
}

function extractJsonArray(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1]!.trim();
  const brackets = text.match(/\[[\s\S]*\]/);
  if (brackets) return brackets[0];
  return text.trim();
}
