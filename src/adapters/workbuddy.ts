import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MarvMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import {
  parseMarkdownEntries,
  readTextFile,
  renderMarkdownList,
  writeMarkdownListFile,
} from "./markdown-sync.js";

const DEFAULT_WORKBUDDY_SCOPE: MemoryScope = { type: "agent", id: "workbuddy" };
const DEFAULT_SOUL_MAX_CHARS = 1_375;
const DEFAULT_USER_MAX_CHARS = 1_375;
const DEFAULT_MEMORY_MAX_CHARS = 2_200;
const WORKBUDDY_INSTRUCTIONS_START = "<!-- marvmem-agent-instructions:start -->";
const WORKBUDDY_INSTRUCTIONS_END = "<!-- marvmem-agent-instructions:end -->";

export type WorkBuddyMemoryPaths = {
  homePath: string;
  soulPath: string;
  userPath: string;
  memoryPath: string;
  nativeMemoryDir: string;
};

export type WorkBuddyImportResult = {
  imported: number;
  soulEntries: number;
  userEntries: number;
  memoryEntries: number;
  nativeMemoryEntries: number;
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
    const [soulEntries, userEntries, memoryEntries, nativeMemoryEntries] = await Promise.all([
      importEntries("soul"),
      importEntries("user"),
      importEntries("memory"),
      importNativeMemory(),
    ]);

    return {
      imported: soulEntries + userEntries + memoryEntries + nativeMemoryEntries,
      soulEntries,
      userEntries,
      memoryEntries,
      nativeMemoryEntries,
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
      writeWorkBuddyMemoryProjection(
        paths.memoryPath,
        memoryEntries,
        params.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS,
      ),
    ]);
  }

  async function importEntries(target: "soul" | "user" | "memory"): Promise<number> {
    const scope = defaultScopes[0]!;
    const path = target === "soul" ? paths.soulPath : target === "user" ? paths.userPath : paths.memoryPath;
    const content = (await readTextFile(path)) ?? "";
    const entries = parseMarkdownEntries(target === "memory" ? stripWorkBuddyInstructions(content) : content);
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

  async function importNativeMemory(): Promise<number> {
    const scope = defaultScopes[0]!;
    const paths = await listNativeMemoryFiles();
    if (paths.length === 0) {
      return 0;
    }
    const existingRecords = await params.memory.list({ scopes: defaultScopes });
    let imported = 0;
    for (const path of paths) {
      const parsed = parseNativeMemoryFile((await readTextFile(path)) ?? "");
      if (!parsed.content) {
        continue;
      }
      const existing = existingRecords.find((record) => {
        const metadata = record.metadata ?? {};
        return metadata.nativeMemoryPath === path;
      });
      const metadata = {
        nativeMemoryPath: path,
        uid: parsed.uid,
        version: parsed.version,
        updatedAt: parsed.updatedAt,
        projectionTarget: "memory",
      };
      const patch = {
        scope,
        kind: "note",
        content: parsed.content,
        summary: parsed.summary,
        source: "workbuddy_native_import",
        tags: ["workbuddy", "native-memory"],
        metadata,
      };
      if (existing) {
        if (existing.content === parsed.content && existing.summary === parsed.summary) {
          continue;
        }
        await params.memory.update(existing.id, patch);
      } else {
        await params.memory.remember(patch);
      }
      imported += 1;
    }
    return imported;
  }

  async function listNativeMemoryFiles(): Promise<string[]> {
    try {
      const entries = await readdir(paths.nativeMemoryDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith("_memory.md"))
        .map((entry) => join(paths.nativeMemoryDir, entry.name))
        .sort();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

export async function writeWorkBuddyInstructions(path: string, updateCommand?: string): Promise<boolean> {
  const current = (await readTextFile(path)) ?? "";
  const next = replaceWorkBuddyInstructions(current, workBuddyInstructionBlock(updateCommand));
  if (next === current) {
    return false;
  }
  await writeText(path, next);
  return true;
}

export function workBuddyInstructionBlock(updateCommand?: string): string {
  const updateLine = updateCommand
    ? `- When the user asks to update or upgrade MarvMem, the memory module, or the memory connector, run \`${updateCommand}\` and then ask WorkBuddy to refresh or reconnect the MarvMem MCP service if needed.`
    : "- When the user asks to update or upgrade MarvMem, the memory module, or the memory connector, run the local `marvmem-agent update workbuddy` command and then ask WorkBuddy to refresh or reconnect the MarvMem MCP service if needed.";
  return `${WORKBUDDY_INSTRUCTIONS_START}
MarvMem memory workflow for WorkBuddy:

- When a request may depend on user preferences, previous project decisions, prior troubleshooting, or cross-agent context, call \`memory_context\` with \`action: "recall"\` before answering. Omit scope so MarvMem can search shared memory.
- When the user asks you to remember something, or states a durable preference or workflow rule, call \`memory_record\` with \`action: "write"\`. You can omit scope; this WorkBuddy connector defaults writes to \`agent:workbuddy\`.
- After substantial work or when closing a task, distill the useful outcome and call \`memory_session\` with \`action: "commit"\`.
${updateLine}
- Do not rely only on WorkBuddy conversation search when MarvMem context could matter.
${WORKBUDDY_INSTRUCTIONS_END}`;
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
    nativeMemoryDir: files?.nativeMemoryDir ?? join(homePath, "memory"),
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

async function writeWorkBuddyMemoryProjection(
  path: string,
  entries: string[],
  maxChars?: number,
): Promise<void> {
  const current = (await readTextFile(path)) ?? "";
  const rendered = renderMarkdownList(entries, maxChars);
  const base = rendered ? `${rendered}\n` : "";
  const next = hasWorkBuddyInstructions(current)
    ? replaceWorkBuddyInstructions(base, extractWorkBuddyInstructions(current) ?? workBuddyInstructionBlock())
    : base;
  await writeText(path, next);
}

function replaceWorkBuddyInstructions(content: string, block: string): string {
  const stripped = stripWorkBuddyInstructions(content).trimEnd();
  const next = stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
  return next;
}

function stripWorkBuddyInstructions(content: string): string {
  const block = extractWorkBuddyInstructions(content);
  if (!block) {
    return content;
  }
  return content.replace(block, "").trim();
}

function extractWorkBuddyInstructions(content: string): string | undefined {
  const startIndex = content.indexOf(WORKBUDDY_INSTRUCTIONS_START);
  const endIndex = content.indexOf(WORKBUDDY_INSTRUCTIONS_END);
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }
  return content.slice(startIndex, endIndex + WORKBUDDY_INSTRUCTIONS_END.length);
}

function hasWorkBuddyInstructions(content: string): boolean {
  return content.includes(WORKBUDDY_INSTRUCTIONS_START);
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function parseNativeMemoryFile(content: string): {
  content: string;
  summary: string;
  uid?: string;
  version?: number;
  updatedAt?: string;
} {
  const rawJson = content.match(/<!-- RAW_JSON_START\s*([\s\S]*?)\s*RAW_JSON_END -->/);
  if (rawJson?.[1]) {
    const parsed = JSON.parse(rawJson[1]) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const memoryBlock = typeof record.memoryBlock === "string" ? record.memoryBlock.trim() : "";
      if (memoryBlock) {
        return {
          content: memoryBlock,
          summary: nativeMemorySummary(record),
          uid: typeof record.uid === "string" ? record.uid : undefined,
          version: typeof record.version === "number" ? record.version : undefined,
          updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
        };
      }
    }
  }
  const withoutRaw = content.replace(/<!-- RAW_JSON_START[\s\S]*?RAW_JSON_END -->/g, "").trim();
  return {
    content: withoutRaw,
    summary: "WorkBuddy native memory profile",
  };
}

function nativeMemorySummary(record: Record<string, unknown>): string {
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : undefined;
  const version = typeof record.version === "number" ? record.version : undefined;
  return [
    "WorkBuddy native memory profile",
    version ? `v${version}` : "",
    updatedAt ? `updated ${updatedAt}` : "",
  ].filter(Boolean).join(" ");
}
