import { homedir } from "node:os";
import { join } from "node:path";
import type { MarvMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import {
  parseMarkdownEntries,
  readTextFile,
  writeMarkdownListFile,
} from "./markdown-sync.js";

const DEFAULT_WORKBUDDY_SCOPE: MemoryScope = { type: "agent", id: "workbuddy" };
const DEFAULT_SOUL_MAX_CHARS = 1_375;
const DEFAULT_USER_MAX_CHARS = 1_375;
const DEFAULT_MEMORY_MAX_CHARS = 2_200;

export type WorkBuddyMemoryPaths = {
  homePath: string;
  soulPath: string;
  userPath: string;
  memoryPath: string;
};

export type WorkBuddyImportResult = {
  imported: number;
  soulEntries: number;
  userEntries: number;
  memoryEntries: number;
};

export type WorkBuddyMemoryAdapter = {
  paths: WorkBuddyMemoryPaths;
  importExistingMemory(): Promise<WorkBuddyImportResult>;
  syncProjection(): Promise<void>;
};

export function createWorkBuddyMemoryAdapter(params: {
  memory: MarvMem;
  defaultScopes?: MemoryScope[];
  files?: Partial<WorkBuddyMemoryPaths>;
  soulMaxChars?: number;
  userMaxChars?: number;
  memoryMaxChars?: number;
}): WorkBuddyMemoryAdapter {
  const defaultScopes = params.defaultScopes?.length
    ? params.defaultScopes
    : [DEFAULT_WORKBUDDY_SCOPE];
  const paths = resolveWorkBuddyPaths(params.files);

  return {
    paths,
    importExistingMemory,
    syncProjection,
  };

  async function importExistingMemory(): Promise<WorkBuddyImportResult> {
    const [soulEntries, userEntries, memoryEntries] = await Promise.all([
      importEntries("soul"),
      importEntries("user"),
      importEntries("memory"),
    ]);

    return {
      imported: soulEntries + userEntries + memoryEntries,
      soulEntries,
      userEntries,
      memoryEntries,
    };
  }

  async function syncProjection(): Promise<void> {
    await importExistingMemory();

    const records = await params.memory.list({ scopes: defaultScopes });
    const soulEntries = records
      .filter((record) => classifyWorkBuddyRecord(record) === "soul")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const userEntries = records
      .filter((record) => classifyWorkBuddyRecord(record) === "user")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));
    const memoryEntries = records
      .filter((record) => classifyWorkBuddyRecord(record) === "memory")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => summarizeRecord(record));

    await Promise.all([
      writeMarkdownListFile(
        paths.soulPath,
        soulEntries,
        params.soulMaxChars ?? DEFAULT_SOUL_MAX_CHARS,
      ),
      writeMarkdownListFile(
        paths.userPath,
        userEntries,
        params.userMaxChars ?? DEFAULT_USER_MAX_CHARS,
      ),
      writeMarkdownListFile(
        paths.memoryPath,
        memoryEntries,
        params.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS,
      ),
    ]);
  }

  async function importEntries(target: "soul" | "user" | "memory"): Promise<number> {
    const scope = defaultScopes[0]!;
    const path = target === "soul" ? paths.soulPath : target === "user" ? paths.userPath : paths.memoryPath;
    const entries = parseMarkdownEntries((await readTextFile(path)) ?? "");
    if (entries.length === 0) {
      return 0;
    }

    const existing = new Set(
      (await params.memory.list({ scopes: defaultScopes }))
        .filter((record) => classifyWorkBuddyRecord(record) === target)
        .flatMap((record) => [record.content.trim(), summarizeRecord(record)])
        .filter(Boolean),
    );

    let imported = 0;
    for (const entry of entries) {
      if (existing.has(entry)) {
        continue;
      }
      await params.memory.remember({
        scope,
        kind: target === "user" ? "preference" : target === "soul" ? "identity" : "note",
        content: entry,
        summary: entry,
        source: "workbuddy_import",
        tags: ["workbuddy", target],
        metadata: { projectionTarget: target },
      });
      existing.add(entry);
      imported += 1;
    }
    return imported;
  }
}

export async function installWorkBuddyMemoryTakeover(params: Parameters<typeof createWorkBuddyMemoryAdapter>[0]): Promise<{
  adapter: WorkBuddyMemoryAdapter;
  imported: WorkBuddyImportResult;
}> {
  const adapter = createWorkBuddyMemoryAdapter(params);
  const imported = await adapter.importExistingMemory();
  await adapter.syncProjection();
  return { adapter, imported };
}

export function resolveWorkBuddyPaths(files?: Partial<WorkBuddyMemoryPaths>): WorkBuddyMemoryPaths {
  const homePath = files?.homePath ?? join(homedir(), ".workbuddy");
  return {
    homePath,
    soulPath: files?.soulPath ?? join(homePath, "SOUL.md"),
    userPath: files?.userPath ?? join(homePath, "USER.md"),
    memoryPath: files?.memoryPath ?? join(homePath, "MEMORY.md"),
  };
}

function classifyWorkBuddyRecord(record: MemoryRecord): "soul" | "user" | "memory" {
  const metadataTarget =
    record.metadata && typeof record.metadata.projectionTarget === "string"
      ? record.metadata.projectionTarget
      : undefined;
  if (metadataTarget === "soul" || metadataTarget === "user" || metadataTarget === "memory") {
    return metadataTarget;
  }
  if (record.tags.includes("soul")) {
    return "soul";
  }
  if (record.kind === "preference" || record.tags.includes("user")) {
    return "user";
  }
  return "memory";
}

function summarizeRecord(record: MemoryRecord): string {
  return record.summary?.trim() || record.content.trim();
}
