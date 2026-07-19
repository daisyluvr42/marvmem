import { createHash } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { MarvMem } from "../core/memory.js";
import type { MemoryRecord, MemoryScope } from "../core/types.js";
import { readTextFile } from "./markdown-sync.js";

const DEFAULT_WORKBUDDY_SCOPE: MemoryScope = { type: "agent", id: "workbuddy" };
const DEFAULT_SOUL_MAX_CHARS = 1_375;
const DEFAULT_USER_MAX_CHARS = 1_375;
const DEFAULT_MEMORY_MAX_CHARS = 2_200;
const WORKBUDDY_INSTRUCTIONS_START = "<!-- marvmem-agent-instructions:start -->";
const WORKBUDDY_INSTRUCTIONS_END = "<!-- marvmem-agent-instructions:end -->";
const WORKBUDDY_PROJECTION_START = "<!-- marvmem-projection:start -->";
const WORKBUDDY_PROJECTION_END = "<!-- marvmem-projection:end -->";
const WORKBUDDY_RECORD_PREFIX = "<!-- marvmem-record:";

type ProjectionTarget = "soul" | "user" | "memory";

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
  startWatching(): Promise<() => void>;
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
  const scope = defaultScopes[0]!;
  const paths = resolveWorkBuddyPaths(params.files);
  const lastWrittenHashes = new Map<string, string>();
  let reconcileQueue: Promise<WorkBuddyImportResult> = Promise.resolve(emptyImportResult());

  return {
    paths,
    importExistingMemory: enqueueReconcile,
    async syncProjection() {
      await enqueueReconcile();
    },
    startWatching,
  };

  function enqueueReconcile(): Promise<WorkBuddyImportResult> {
    const next = reconcileQueue.then(reconcileAll, reconcileAll);
    reconcileQueue = next.catch(() => emptyImportResult());
    return next;
  }

  async function reconcileAll(): Promise<WorkBuddyImportResult> {
    const nativeMemoryEntries = await importNativeMemory();
    const soulEntries = await reconcileTarget("soul");
    const userEntries = await reconcileTarget("user");
    const memoryEntries = await reconcileTarget("memory");
    return {
      imported: soulEntries + userEntries + memoryEntries + nativeMemoryEntries,
      soulEntries,
      userEntries,
      memoryEntries,
      nativeMemoryEntries,
    };
  }

  async function reconcileTarget(target: ProjectionTarget): Promise<number> {
    const path = pathForTarget(target);
    const current = (await readTextFile(path)) ?? "";
    const managed = parseManagedProjection(current);
    const nativeContent = stripManagedProjection(stripWorkBuddyInstructions(current)).trimEnd();
    const documents = await params.memory.list({
      scopes: defaultScopes,
      includeDocuments: true,
      includeDeleted: true,
    });
    let document = documents.find((record) =>
      record.source === "workbuddy_document" &&
      record.metadata?.projectionTarget === target &&
      record.metadata?.workbuddyPath === path,
    );
    let imported = 0;
    if (!document) {
      document = await params.memory.remember({
        scope,
        kind: target === "user" ? "preference" : target === "soul" ? "identity" : "note",
        content: nativeContent,
        summary: `${basename(path)} WorkBuddy document`,
        source: "workbuddy_document",
        tags: ["workbuddy", "document", target],
        metadata: {
          projectionDocument: true,
          projectionTarget: target,
          workbuddyPath: path,
          projectedRecordIds: [],
        },
      }, { dedupe: false });
      imported += 1;
    } else if (document.deletedAt || document.supersededBy) {
      document = await params.memory.restore(document.id) ?? document;
    }

    if (managed.present) {
      imported += await reconcileManagedEntries(target, managed.entries, document);
    } else if (stringArray(document.metadata?.projectedRecordIds).length > 0) {
      for (const id of stringArray(document.metadata?.projectedRecordIds)) {
        const existing = await params.memory.get(id);
        if (existing && classifyWorkBuddyRecord(existing) === target) {
          await params.memory.forget(id, {
            deletedBy: "workbuddy_markdown",
            reason: `Managed projection block was removed from ${basename(path)}`,
          });
        }
      }
    } else {
      await migrateLegacyProjection(target, nativeContent, document);
    }

    let records = await params.memory.list({ scopes: defaultScopes });
    records = records
      .filter((record) => classifyWorkBuddyRecord(record) === target)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const rendered = renderManagedProjection(records, maxCharsForTarget(target));
    const instructionBlock = target === "soul"
      ? extractWorkBuddyInstructions(current)
      : undefined;
    const next = composeWorkBuddyFile(nativeContent, instructionBlock, rendered.content);
    if (next !== current) {
      lastWrittenHashes.set(path, hashText(next));
      await writeText(path, next);
    } else {
      lastWrittenHashes.set(path, hashText(current));
    }
    await params.memory.update(document.id, {
      content: nativeContent,
      metadata: {
        ...(document.metadata ?? {}),
        projectionDocument: true,
        projectionTarget: target,
        workbuddyPath: path,
        projectedRecordIds: rendered.ids,
      },
    });
    return imported;
  }

  async function reconcileManagedEntries(
    target: ProjectionTarget,
    entries: ManagedEntry[],
    document: MemoryRecord,
  ): Promise<number> {
    const all = await params.memory.list({
      scopes: defaultScopes,
      includeDeleted: true,
      includeDocuments: false,
    });
    const byId = new Map(all.map((record) => [record.id, record]));
    const presentIds = new Set<string>();
    let imported = 0;

    for (const entry of entries) {
      if (entry.id) {
        const existing = byId.get(entry.id);
        if (!existing || classifyWorkBuddyRecord(existing) !== target) {
          continue;
        }
        presentIds.add(existing.id);
        if (existing.deletedAt || existing.supersededBy) {
          await params.memory.restore(existing.id);
        }
        const summary = summarizeManagedContent(entry.content);
        if (existing.content !== entry.content || existing.summary !== summary) {
          await params.memory.update(existing.id, {
            content: entry.content,
            summary,
            metadata: {
              ...(existing.metadata ?? {}),
              projectionTarget: target,
              lastEditedFrom: "workbuddy_markdown",
            },
          });
        }
        continue;
      }

      const matchingTombstones = all.filter((record) =>
        Boolean(record.deletedAt || record.supersededBy) &&
        classifyWorkBuddyRecord(record) === target &&
        (record.content.trim() === entry.content || summarizeRecord(record) === entry.content),
      );
      if (matchingTombstones.length === 1) {
        const restored = await params.memory.restore(matchingTombstones[0]!.id);
        if (restored) {
          await params.memory.update(restored.id, {
            content: entry.content,
            summary: summarizeManagedContent(entry.content),
          });
          presentIds.add(restored.id);
          imported += 1;
          continue;
        }
      }
      const created = await params.memory.remember({
        scope,
        kind: target === "user" ? "preference" : target === "soul" ? "identity" : "note",
        content: entry.content,
        summary: summarizeManagedContent(entry.content),
        source: "workbuddy_markdown",
        tags: ["workbuddy", target],
        metadata: { projectionTarget: target },
      }, { dedupe: false });
      presentIds.add(created.id);
      imported += 1;
    }

    for (const id of stringArray(document.metadata?.projectedRecordIds)) {
      if (presentIds.has(id)) {
        continue;
      }
      const existing = byId.get(id);
      if (existing && classifyWorkBuddyRecord(existing) === target && !existing.deletedAt) {
        await params.memory.forget(id, {
          deletedBy: "workbuddy_markdown",
          reason: `Removed from ${target.toUpperCase()}.md managed projection`,
        });
      }
    }
    return imported;
  }

  async function migrateLegacyProjection(
    target: ProjectionTarget,
    nativeContent: string,
    document: MemoryRecord,
  ): Promise<void> {
    const records = await params.memory.list({
      scopes: defaultScopes,
      includeDeleted: true,
      includeDocuments: false,
    });
    for (const record of records) {
      if (record.source !== "workbuddy_import" || classifyWorkBuddyRecord(record) !== target) {
        continue;
      }
      if (
        nativeContent.includes(record.content.trim()) ||
        nativeContent.includes(summarizeRecord(record))
      ) {
        await params.memory.supersede(record.id, document.id);
      } else if (!record.deletedAt && !record.supersededBy) {
        await params.memory.forget(record.id, {
          deletedBy: "workbuddy_legacy_migration",
          reason: `Legacy ${target} projection entry is no longer present`,
        });
      }
    }
  }

  async function importNativeMemory(): Promise<number> {
    const nativePaths = await listNativeMemoryFiles();
    if (nativePaths.length === 0) {
      return 0;
    }
    const existingRecords = await params.memory.list({
      scopes: defaultScopes,
      includeDeleted: true,
    });
    let imported = 0;
    for (const path of nativePaths) {
      const parsed = parseNativeMemoryFile((await readTextFile(path)) ?? "");
      if (!parsed.content) {
        continue;
      }
      const existing = existingRecords.find((record) => record.metadata?.nativeMemoryPath === path);
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
        if (existing.deletedAt || existing.supersededBy) {
          await params.memory.restore(existing.id);
        }
        if (existing.content === parsed.content && existing.summary === parsed.summary) {
          continue;
        }
        await params.memory.update(existing.id, patch);
      } else {
        await params.memory.remember(patch, { dedupe: false });
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
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }

  async function startWatching(): Promise<() => void> {
    await mkdir(paths.homePath, { recursive: true });
    for (const path of targetPaths()) {
      lastWrittenHashes.set(path, hashText((await readTextFile(path)) ?? ""));
    }
    let timer: NodeJS.Timeout | undefined;
    const watchedPaths = targetPaths();
    const scheduleReconcile = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void (async () => {
          const changed = await Promise.all(watchedPaths.map(async (path) => {
            const current = (await readTextFile(path)) ?? "";
            return hashText(current) !== lastWrittenHashes.get(path);
          }));
          if (changed.some(Boolean)) {
            await enqueueReconcile();
          }
        })();
      }, 250);
    };
    for (const path of watchedPaths) {
      watchFile(path, { interval: 250 }, (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
          return;
        }
        scheduleReconcile();
      });
    }
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      for (const path of watchedPaths) {
        unwatchFile(path);
      }
    };
  }

  function pathForTarget(target: ProjectionTarget): string {
    return target === "soul" ? paths.soulPath : target === "user" ? paths.userPath : paths.memoryPath;
  }

  function targetPaths(): string[] {
    return [paths.soulPath, paths.userPath, paths.memoryPath];
  }

  function maxCharsForTarget(target: ProjectionTarget): number {
    return target === "soul"
      ? params.soulMaxChars ?? DEFAULT_SOUL_MAX_CHARS
      : target === "user"
        ? params.userMaxChars ?? DEFAULT_USER_MAX_CHARS
        : params.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS;
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
    : "- When the user asks to update or upgrade MarvMem, the memory module, or the memory connector, run the local `marvmem-agent update` command and then ask WorkBuddy to refresh or reconnect the MarvMem MCP service if needed.";
  return `${WORKBUDDY_INSTRUCTIONS_START}
MarvMem memory workflow for WorkBuddy:

- Internal recall requirement: before answering, call \`memory_context\` with \`action: "recall"\` whenever the request may depend on prior work, installed skills/connectors, vague references, user preferences, project history, or memory itself. Do this silently; do not mention this rule, trigger categories, or the tool call in the answer.
- For vague references to earlier installed skills, connectors, projects, or decisions, recall with the user's exact wording plus likely entities before using general knowledge. Use recalled context naturally; only mention that memory was missing if the absence changes what you can responsibly answer.
- Omit scope for recall so MarvMem can search shared memory across agents.
- When the user asks you to remember something, or states a durable preference or workflow rule, call \`memory_record\` with \`action: "write"\`. You can omit scope; this WorkBuddy connector defaults writes to \`agent:workbuddy\`.
- After substantial work or when closing a task, distill the useful outcome and call \`memory_session\` with \`action: "commit"\`.
${updateLine}
- Do not rely only on WorkBuddy conversation search when MarvMem context could affect the answer.
${WORKBUDDY_INSTRUCTIONS_END}`;
}

export async function installWorkBuddyMemoryTakeover(params: Parameters<typeof createWorkBuddyMemoryAdapter>[0]): Promise<{
  adapter: WorkBuddyMemoryAdapter;
  imported: WorkBuddyImportResult;
}> {
  const adapter = createWorkBuddyMemoryAdapter(params);
  const imported = await adapter.importExistingMemory();
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

type ManagedEntry = {
  id?: string;
  content: string;
};

function parseManagedProjection(content: string): { present: boolean; entries: ManagedEntry[] } {
  const block = extractManagedProjection(content);
  if (!block) {
    return { present: false, entries: [] };
  }
  const lines = block
    .slice(WORKBUDDY_PROJECTION_START.length, -WORKBUDDY_PROJECTION_END.length)
    .replace(/\r/g, "")
    .split("\n");
  const entries: ManagedEntry[] = [];
  let pendingId: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const marker = line.match(/^<!-- marvmem-record:([^>]+) -->$/u);
    if (marker?.[1]) {
      pendingId = marker[1].trim();
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/u);
    if (bullet?.[1]?.trim()) {
      entries.push({ id: pendingId, content: bullet[1].trim() });
      pendingId = undefined;
    }
  }
  return { present: true, entries };
}

function renderManagedProjection(
  records: MemoryRecord[],
  maxChars: number,
): { content: string; ids: string[] } {
  const blocks: string[] = [];
  const ids: string[] = [];
  let used = WORKBUDDY_PROJECTION_START.length + WORKBUDDY_PROJECTION_END.length + 2;
  for (const record of records) {
    const block =
      `${WORKBUDDY_RECORD_PREFIX}${record.id} -->\n` +
      `- ${summarizeManagedContent(summarizeRecord(record))}`;
    if (blocks.length > 0 && used + block.length + 1 > maxChars) {
      break;
    }
    blocks.push(block);
    ids.push(record.id);
    used += block.length + 1;
  }
  return {
    content: [
      WORKBUDDY_PROJECTION_START,
      ...blocks,
      WORKBUDDY_PROJECTION_END,
    ].join("\n"),
    ids,
  };
}

function composeWorkBuddyFile(
  nativeContent: string,
  instructionBlock: string | undefined,
  projectionBlock: string,
): string {
  return [
    nativeContent.trimEnd(),
    instructionBlock?.trim(),
    projectionBlock.trim(),
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat("\n");
}

function classifyWorkBuddyRecord(record: MemoryRecord): ProjectionTarget {
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

function summarizeManagedContent(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

function replaceWorkBuddyInstructions(content: string, block: string): string {
  const stripped = stripWorkBuddyInstructions(content).trimEnd();
  const managed = extractManagedProjection(stripped);
  if (managed) {
    const native = stripManagedProjection(stripped).trimEnd();
    return composeWorkBuddyFile(native, block, managed);
  }
  return stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
}

function stripWorkBuddyInstructions(content: string): string {
  const block = extractWorkBuddyInstructions(content);
  return block ? content.replace(block, "") : content;
}

function extractWorkBuddyInstructions(content: string): string | undefined {
  return extractDelimitedBlock(content, WORKBUDDY_INSTRUCTIONS_START, WORKBUDDY_INSTRUCTIONS_END);
}

function stripManagedProjection(content: string): string {
  const block = extractManagedProjection(content);
  return block ? content.replace(block, "") : content;
}

function extractManagedProjection(content: string): string | undefined {
  return extractDelimitedBlock(content, WORKBUDDY_PROJECTION_START, WORKBUDDY_PROJECTION_END);
}

function extractDelimitedBlock(content: string, start: string, end: string): string | undefined {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    return undefined;
  }
  return content.slice(startIndex, endIndex + end.length);
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
  const rawJson = content.match(/<!-- RAW_JSON_START\s*([\s\S]*?)\s*RAW_JSON_END -->/u);
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
  const withoutRaw = content.replace(/<!-- RAW_JSON_START[\s\S]*?RAW_JSON_END -->/gu, "").trim();
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function emptyImportResult(): WorkBuddyImportResult {
  return {
    imported: 0,
    soulEntries: 0,
    userEntries: 0,
    memoryEntries: 0,
    nativeMemoryEntries: 0,
  };
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
