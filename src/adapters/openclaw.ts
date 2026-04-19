import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MarvMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import type { MemoryRuntime } from "../runtime/index.js";
import {
  createSessionMemoryAdapter,
  type MemoryAdapterPromptInput,
  type MemoryAdapterTurnInput,
  type SessionMemoryAdapter,
} from "./base.js";
import {
  listMarkdownFiles,
  parseMarkdownEntries,
  readTextFile,
  writeMarkdownBlocksFile,
  writeMarkdownListFile,
} from "./markdown-sync.js";

const DEFAULT_OPENCLAW_SCOPE: MemoryScope = { type: "agent", id: "openclaw" };

export type OpenClawMemoryPaths = {
  workspacePath: string;
  memoryPath: string;
  dreamsPath: string;
  dailyDir: string;
};

export type OpenClawImportResult = {
  imported: number;
  memoryEntries: number;
  dailyEntries: number;
  dreamEntries: number;
};

export type OpenClawMemoryAdapter = SessionMemoryAdapter & {
  paths: OpenClawMemoryPaths;
  importExistingMemory(): Promise<OpenClawImportResult>;
  syncProjection(): Promise<void>;
};

export function createOpenClawMemoryAdapter(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
  files?: Partial<OpenClawMemoryPaths>;
  now?: () => Date;
}): OpenClawMemoryAdapter {
  const defaultScopes = params.defaultScopes?.length
    ? params.defaultScopes
    : [DEFAULT_OPENCLAW_SCOPE];
  const base = createSessionMemoryAdapter({
    memory: params.memory,
    runtime: params.runtime,
    defaultScopes,
  });
  const paths = resolveOpenClawPaths(params.files);
  const now = params.now ?? (() => new Date());
  const liveDailyBlocks: string[] = [];
  let todaySeedBlocks: string[] | null = null;

  return {
    tools: base.tools,
    paths,
    async beforePrompt(input: MemoryAdapterPromptInput) {
      return await base.beforePrompt({
        ...input,
        scopes: input.scopes ?? defaultScopes,
      });
    },
    async afterTurn(input: MemoryAdapterTurnInput) {
      liveDailyBlocks.push(buildLiveDailyBlock(input));
      await base.afterTurn({
        ...input,
        scopes: input.scopes ?? defaultScopes,
      });
      await syncProjection();
    },
    async flushSession(input = {}) {
      const dailyContent = liveDailyBlocks.map((block) => block.trim()).filter(Boolean).join("\n\n").trim();
      if (dailyContent) {
        await params.memory.remember({
          scope: defaultScopes[0]!,
          kind: "openclaw_daily",
          content: dailyContent,
          summary: summarizeDailyBlock(dailyContent),
          source: "openclaw_session",
          tags: ["openclaw", "daily"],
          metadata: {
            projectionTarget: "daily",
            day: currentDay(now()),
          },
        });
      }
      liveDailyBlocks.length = 0;
      await base.flushSession({
        scopes: input.scopes ?? defaultScopes,
      });
      await syncProjection();
    },
    importExistingMemory,
    syncProjection,
  };

  async function importExistingMemory(): Promise<OpenClawImportResult> {
    const scope = defaultScopes[0]!;
    const memoryEntries = parseMarkdownEntries((await readTextFile(paths.memoryPath)) ?? "");
    for (const entry of memoryEntries) {
      await params.memory.remember({
        scope,
        kind: "note",
        content: entry,
        summary: entry,
        source: "openclaw_import",
        tags: ["openclaw", "memory"],
        metadata: { projectionTarget: "memory" },
      });
    }

    let dailyEntries = 0;
    for (const file of await listMarkdownFiles(paths.dailyDir)) {
      const day = basename(file, ".md");
      const blocks = parseMarkdownEntries((await readTextFile(file)) ?? "");
      dailyEntries += blocks.length;
      for (const block of blocks) {
        await params.memory.remember({
          scope,
          kind: "openclaw_daily",
          content: block,
          summary: summarizeDailyBlock(block),
          source: "openclaw_import",
          tags: ["openclaw", "daily"],
          metadata: {
            projectionTarget: "daily",
            day,
          },
        });
      }
    }

    const dreamEntries = parseMarkdownEntries((await readTextFile(paths.dreamsPath)) ?? "");
    for (const entry of dreamEntries) {
      await params.memory.remember({
        scope,
        kind: "experience",
        content: entry,
        summary: entry,
        source: "openclaw_import",
        tags: ["openclaw", "dreams"],
        metadata: { projectionTarget: "dreams" },
      });
    }

    todaySeedBlocks = [];

    return {
      imported: memoryEntries.length + dailyEntries + dreamEntries.length,
      memoryEntries: memoryEntries.length,
      dailyEntries,
      dreamEntries: dreamEntries.length,
    };
  }

  async function syncProjection(): Promise<void> {
    const records = await params.memory.list({ scopes: defaultScopes });
    const memoryEntries = records
      .filter((record) => classifyOpenClawRecord(record) === "memory")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const dailyBlocks = records
      .filter(
        (record) =>
          classifyOpenClawRecord(record) === "daily" &&
          readRecordDay(record) === currentDay(now()),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((record) => record.content.trim())
      .filter(Boolean);
    const dreamsEntries = records
      .filter((record) => classifyOpenClawRecord(record) === "dreams")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const currentDailyPath = join(paths.dailyDir, `${currentDay(now())}.md`);

    await ensureTodaySeedLoaded(currentDailyPath);

    await writeMarkdownListFile(paths.memoryPath, memoryEntries);
    await writeMarkdownBlocksFile(currentDailyPath, [
      ...(todaySeedBlocks ?? []),
      ...dailyBlocks,
      ...liveDailyBlocks,
    ]);

    if (dreamsEntries.length > 0 || (await readTextFile(paths.dreamsPath)) !== null) {
      await writeMarkdownListFile(paths.dreamsPath, dreamsEntries);
    }
  }

  async function ensureTodaySeedLoaded(currentDailyPath: string): Promise<void> {
    if (todaySeedBlocks !== null) {
      return;
    }
    const text = await readTextFile(currentDailyPath);
    todaySeedBlocks = text ? parseMarkdownEntries(text) : [];
  }
}

export async function installOpenClawMemoryTakeover(params: Parameters<typeof createOpenClawMemoryAdapter>[0]): Promise<{
  adapter: OpenClawMemoryAdapter;
  imported: OpenClawImportResult;
}> {
  const adapter = createOpenClawMemoryAdapter(params);
  const imported = await adapter.importExistingMemory();
  await adapter.syncProjection();
  return { adapter, imported };
}

function resolveOpenClawPaths(files?: Partial<OpenClawMemoryPaths>): OpenClawMemoryPaths {
  const workspacePath = files?.workspacePath ?? join(homedir(), ".openclaw", "workspace");
  return {
    workspacePath,
    memoryPath: files?.memoryPath ?? join(workspacePath, "MEMORY.md"),
    dreamsPath: files?.dreamsPath ?? join(workspacePath, "DREAMS.md"),
    dailyDir: files?.dailyDir ?? join(workspacePath, "memory"),
  };
}

function buildLiveDailyBlock(input: MemoryAdapterTurnInput): string {
  const lines = [
    input.taskTitle?.trim() ? `Task: ${input.taskTitle.trim()}` : "",
    input.userMessage.trim() ? `user: ${input.userMessage.trim()}` : "",
    input.assistantMessage?.trim() ? `assistant: ${input.assistantMessage.trim()}` : "",
    input.toolContext?.trim() ? `context: ${input.toolContext.trim()}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function currentDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function summarizeDailyBlock(content: string): string {
  const firstLine = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? content.trim();
  return firstLine.length <= 120 ? firstLine : `${firstLine.slice(0, 117).trimEnd()}...`;
}

function classifyOpenClawRecord(record: MemoryRecord): "memory" | "daily" | "dreams" {
  const metadataTarget =
    record.metadata && typeof record.metadata.projectionTarget === "string"
      ? record.metadata.projectionTarget
      : undefined;
  if (metadataTarget === "daily" || metadataTarget === "dreams" || metadataTarget === "memory") {
    return metadataTarget;
  }
  if (record.kind === "experience" || record.tags.includes("dreams")) {
    return "dreams";
  }
  return "memory";
}

function readRecordDay(record: MemoryRecord): string | undefined {
  return record.metadata && typeof record.metadata.day === "string" ? record.metadata.day : undefined;
}

function summarizeRecord(record: MemoryRecord): string {
  return record.summary?.trim() || record.content.trim();
}
