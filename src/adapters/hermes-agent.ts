import { homedir } from "node:os";
import { join } from "node:path";
import type { MarvMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import type { MemoryRuntime } from "../runtime/index.js";
import {
  createSessionMemoryAdapter,
  type MemoryAdapterPromptInput,
  type MemoryAdapterTurnInput,
  type SessionMemoryAdapter,
} from "./base.js";
import { readMarkdownEntries, writeMarkdownListFile } from "./markdown-sync.js";

const DEFAULT_HERMES_SCOPE: MemoryScope = { type: "agent", id: "hermes" };
const DEFAULT_MEMORY_MAX_CHARS = 2_200;
const DEFAULT_USER_MAX_CHARS = 1_375;

export type HermesMemoryPaths = {
  memoryPath: string;
  userPath: string;
};

export type HermesImportResult = {
  imported: number;
  memoryEntries: number;
  userEntries: number;
};

export type HermesAgentMemoryAdapter = SessionMemoryAdapter & {
  paths: HermesMemoryPaths;
  importExistingMemory(): Promise<HermesImportResult>;
  syncProjection(): Promise<void>;
};

export type HermesMemoryWriteInput = {
  memory: MarvMem;
  scopes?: MemoryScope[];
  action: "add" | "replace" | "remove";
  target: "memory" | "user";
  content?: string;
  oldText?: string;
};

export function createHermesAgentMemoryAdapter(params: {
  memory: MarvMem;
  runtime?: MemoryRuntime;
  defaultScopes?: MemoryScope[];
  files?: Partial<HermesMemoryPaths>;
  memoryMaxChars?: number;
  userMaxChars?: number;
}): HermesAgentMemoryAdapter {
  const defaultScopes = params.defaultScopes?.length
    ? params.defaultScopes
    : [DEFAULT_HERMES_SCOPE];
  const base = createSessionMemoryAdapter({
    memory: params.memory,
    runtime: params.runtime,
    defaultScopes,
  });
  const paths = resolveHermesPaths(params.files);

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
      await base.afterTurn({
        ...input,
        scopes: input.scopes ?? defaultScopes,
      });
      await syncProjection();
    },
    async flushSession(input = {}) {
      await base.flushSession({
        scopes: input.scopes ?? defaultScopes,
      });
      await syncProjection();
    },
    importExistingMemory,
    syncProjection,
  };

  async function importExistingMemory(): Promise<HermesImportResult> {
    const scope = defaultScopes[0]!;
    const [memoryEntries, userEntries] = await Promise.all([
      readMarkdownEntries(paths.memoryPath),
      readMarkdownEntries(paths.userPath),
    ]);

    for (const entry of memoryEntries) {
      await params.memory.remember({
        scope,
        kind: "note",
        content: entry,
        summary: entry,
        source: "hermes_import",
        tags: ["hermes", "memory"],
        metadata: { projectionTarget: "memory" },
      });
    }

    for (const entry of userEntries) {
      await params.memory.remember({
        scope,
        kind: "preference",
        content: entry,
        summary: entry,
        source: "hermes_import",
        tags: ["hermes", "user"],
        metadata: { projectionTarget: "user" },
      });
    }

    return {
      imported: memoryEntries.length + userEntries.length,
      memoryEntries: memoryEntries.length,
      userEntries: userEntries.length,
    };
  }

  async function syncProjection(): Promise<void> {
    const records = await params.memory.list({ scopes: defaultScopes });
    const memoryEntries = records
      .filter((record) => classifyHermesRecord(record) === "memory")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const userEntries = records
      .filter((record) => classifyHermesRecord(record) === "user")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));

    await Promise.all([
      writeMarkdownListFile(
        paths.memoryPath,
        memoryEntries,
        params.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS,
      ),
      writeMarkdownListFile(
        paths.userPath,
        userEntries,
        params.userMaxChars ?? DEFAULT_USER_MAX_CHARS,
      ),
    ]);
  }
}

export async function installHermesAgentMemoryTakeover(params: Parameters<typeof createHermesAgentMemoryAdapter>[0]): Promise<{
  adapter: HermesAgentMemoryAdapter;
  imported: HermesImportResult;
}> {
  const adapter = createHermesAgentMemoryAdapter(params);
  const imported = await adapter.importExistingMemory();
  await adapter.syncProjection();
  return { adapter, imported };
}

export async function applyHermesMemoryWrite(input: HermesMemoryWriteInput): Promise<boolean> {
  const scopes = input.scopes?.length ? input.scopes : [DEFAULT_HERMES_SCOPE];
  const content = input.content?.trim();
  const oldText = input.oldText?.trim();

  if (input.action === "add") {
    if (!content) {
      return false;
    }
    await input.memory.remember({
      scope: scopes[0]!,
      kind: input.target === "user" ? "preference" : "note",
      content,
      summary: content,
      source: "hermes_memory_tool",
      tags: input.target === "user" ? ["hermes", "user"] : ["hermes", "memory"],
      metadata: { projectionTarget: input.target },
    });
    return true;
  }

  if (!oldText) {
    return false;
  }

  const records = (await input.memory.list({ scopes }))
    .filter((record) => classifyHermesRecord(record) === input.target)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const match = records.find((record) => {
    const summary = summarizeRecord(record);
    return summary.includes(oldText) || record.content.includes(oldText);
  });

  if (!match) {
    if (input.action === "replace" && content) {
      await input.memory.remember({
        scope: scopes[0]!,
        kind: input.target === "user" ? "preference" : "note",
        content,
        summary: content,
        source: "hermes_memory_tool",
        tags: input.target === "user" ? ["hermes", "user"] : ["hermes", "memory"],
        metadata: { projectionTarget: input.target },
      });
      return true;
    }
    return false;
  }

  if (input.action === "remove") {
    return await input.memory.forget(match.id);
  }

  if (!content) {
    return false;
  }

  const metadata =
    match.metadata && typeof match.metadata === "object"
      ? { ...match.metadata, projectionTarget: input.target }
      : { projectionTarget: input.target };
  const updated = await input.memory.update(match.id, {
    content,
    summary: content,
    source: "hermes_memory_tool",
    metadata,
  });
  return updated !== null;
}

function resolveHermesPaths(files?: Partial<HermesMemoryPaths>): HermesMemoryPaths {
  const memoryRoot = join(homedir(), ".hermes", "memories");
  return {
    memoryPath: files?.memoryPath ?? join(memoryRoot, "MEMORY.md"),
    userPath: files?.userPath ?? join(memoryRoot, "USER.md"),
  };
}

function classifyHermesRecord(record: MemoryRecord): "memory" | "user" {
  const metadataTarget =
    record.metadata && typeof record.metadata.projectionTarget === "string"
      ? record.metadata.projectionTarget
      : undefined;
  if (metadataTarget === "user" || metadataTarget === "memory") {
    return metadataTarget;
  }
  if (record.kind === "preference" || record.kind === "identity") {
    return "user";
  }
  if (record.tags.includes("user")) {
    return "user";
  }
  return "memory";
}

function summarizeRecord(record: MemoryRecord): string {
  return record.summary?.trim() || record.content.trim();
}
