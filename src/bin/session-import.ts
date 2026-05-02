import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMarvMem, type MarvMem } from "../core/index.js";
import type { MemoryRecord, MemoryScope, MemoryScopeType } from "../core/types.js";

export type SessionImportOptions = {
  sessionsRoot: string;
  storagePath: string;
  scope: MemoryScope;
};

export type ImportedSessionMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ImportedSession = {
  path: string;
  id: string;
  timestamp?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  messages: ImportedSessionMessage[];
};

export type SessionImportReadResult = {
  files: number;
  sessions: ImportedSession[];
};

export async function runSessionImport(input: {
  agentKey: string;
  agentLabel: string;
  options: SessionImportOptions;
  readSessions(root: string): Promise<SessionImportReadResult>;
}): Promise<void> {
  const memory = createMarvMem({
    storage: {
      backend: "sqlite",
      path: input.options.storagePath,
    },
  });
  const result = await input.readSessions(input.options.sessionsRoot);
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let messages = 0;
  const source = `${input.agentKey}_session_import`;

  for (const session of result.sessions) {
    if (session.messages.length === 0 || !session.messages.some((message) => message.role === "user")) {
      skipped += 1;
      continue;
    }

    const taskId = taskIdForSession(input.agentKey, session.id);
    const existingTask = await memory.task.get(taskId);
    const existingRecord = await findSessionRecord({
      memory,
      scope: input.options.scope,
      source,
      sessionId: session.id,
      taskId,
    });
    const importedMessageCount = existingTask
      ? await importedMessageCountForSession({
          memory,
          taskId,
          record: existingRecord,
          maxCount: session.messages.length,
        })
      : 0;
    const newMessages = session.messages.slice(importedMessageCount);
    const refreshExistingRecord = existingRecord ? shouldRefreshSessionRecord(existingRecord) : false;

    if (existingTask && existingRecord && newMessages.length === 0 && !refreshExistingRecord) {
      skipped += 1;
      continue;
    }

    if (!existingTask) {
      await memory.task.create({
        taskId,
        scope: input.options.scope,
        title: titleForSession(input.agentLabel, session),
        status: "completed",
      });
    }
    for (const message of newMessages) {
      await memory.task.appendEntry({
        taskId,
        role: message.role,
        content: message.content,
      });
    }
    const state = await memory.task.distillRollingSummary({
      taskId,
      limit: Math.max(48, newMessages.length || session.messages.length),
    });
    const metadata = sessionRecordMetadata({
      session,
      taskId,
      previous: existingRecord?.metadata,
      resumed: Boolean(existingTask && newMessages.length > 0),
    });
    const patch = {
      scope: input.options.scope,
      kind: "note",
      content: sessionRecordContent(input.agentLabel, input.agentKey, session, state?.rollingSummary),
      summary: summaryForSession(input.agentLabel, session, state?.rollingSummary),
      confidence: 0.9,
      importance: 0.6,
      source,
      tags: [input.agentKey, "session"],
      metadata,
    };

    if (existingRecord) {
      await memory.update(existingRecord.id, patch);
    } else {
      await memory.remember(patch);
    }

    if (existingTask) {
      updated += 1;
    } else {
      imported += 1;
    }
    messages += newMessages.length;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        sessionsRoot: input.options.sessionsRoot,
        storagePath: input.options.storagePath,
        scope: `${input.options.scope.type}:${input.options.scope.id}`,
        files: result.files,
        sessions: result.sessions.length,
        imported,
        updated,
        skipped,
        messages,
      },
      null,
      2,
    )}\n`,
  );
}

export function parseImportOptions(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  defaultRoot: string;
  defaultStoragePath: string;
  defaultScopeId: string;
  help: string;
}): SessionImportOptions {
  let sessionsRoot = input.defaultRoot;
  let storagePath = input.env.MARVMEM_STORAGE_PATH ?? input.defaultStoragePath;
  let scopeType = input.env.MARVMEM_SCOPE_TYPE ?? "agent";
  let scopeId = input.env.MARVMEM_SCOPE_ID ?? input.defaultScopeId;

  for (let index = 0; index < input.argv.length; index += 1) {
    const arg = input.argv[index];
    if (arg === "--help") {
      process.stdout.write(`${input.help}\n`);
      process.exit(0);
    }
    if (arg === "--storage-path") {
      storagePath = readFlagValue(input.argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-type") {
      scopeType = readFlagValue(input.argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-id") {
      scopeId = readFlagValue(input.argv, ++index, arg);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    sessionsRoot = arg;
  }

  return {
    sessionsRoot,
    storagePath,
    scope: {
      type: scopeType as MemoryScopeType,
      id: scopeId,
    },
  };
}

export async function findFiles(
  root: string,
  predicate: (path: string, name: string) => boolean,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findFiles(path, predicate)));
    } else if (entry.isFile() && predicate(path, entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readWorkspaceFolderFromChatSession(path: string): Promise<string | undefined> {
  const workspacePath = join(dirname(dirname(path)), "workspace.json");
  try {
    const value = asObject(await readJsonFile(workspacePath));
    const folder = stringValue(value.folder) ?? stringValue(value.workspace);
    if (!folder) {
      return undefined;
    }
    if (folder.startsWith("file://")) {
      return fileURLToPath(new URL(folder));
    }
    return folder;
  } catch {
    return undefined;
  }
}

export function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isoFromTimestamp(value: unknown): string | undefined {
  const timestamp = numberValue(value);
  return timestamp ? new Date(timestamp).toISOString() : stringValue(value);
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      const record = asObject(item);
      const type = stringValue(record.type) ?? stringValue(record.kind);
      if (type && type !== "text" && type !== "input_text" && type !== "output_text") {
        return "";
      }
      return stringValue(record.text) ?? stringValue(record.content) ?? stringValue(record.value) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function textFromVsCodeResponse(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return textFromResponsePart(value);
  }
  return value.map(textFromResponsePart).filter(Boolean).join("\n");
}

function textFromResponsePart(value: unknown): string {
  const record = asObject(value);
  return stringValue(record.value) ?? stringValue(record.text) ?? stringValue(record.content) ?? "";
}

export function clamp(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd();
}

function taskIdForSession(agentKey: string, sessionId: string): string {
  return `${agentKey}:${sessionId}`;
}

function titleForSession(agentLabel: string, session: ImportedSession): string {
  const cwdName = session.cwd ? basename(session.cwd) : "session";
  const firstUser = session.messages.find((message) => message.role === "user")?.content ?? "";
  return clamp(`${agentLabel} ${cwdName}: ${firstUser}`, 120);
}

async function findSessionRecord(input: {
  memory: MarvMem;
  scope: MemoryScope;
  source: string;
  sessionId: string;
  taskId: string;
}): Promise<MemoryRecord | null> {
  const records = await input.memory.list({ scopes: [input.scope] });
  return (
    records.find((record) => {
      const metadata = asObject(record.metadata);
      return (
        record.source === input.source &&
        stringValue(metadata.sessionId) === input.sessionId &&
        stringValue(metadata.taskId) === input.taskId
      );
    }) ?? null
  );
}

async function importedMessageCountForSession(input: {
  memory: MarvMem;
  taskId: string;
  record: MemoryRecord | null;
  maxCount: number;
}): Promise<number> {
  const metadataCount = numberValue(input.record?.metadata?.messageCount);
  if (metadataCount !== undefined) {
    return clampCount(metadataCount, input.maxCount);
  }
  const entries = await input.memory.task.listEntries(input.taskId, { limit: input.maxCount });
  return clampCount(entries.length, input.maxCount);
}

function clampCount(count: number, maxCount: number): number {
  return Math.max(0, Math.min(Math.floor(count), maxCount));
}

function shouldRefreshSessionRecord(record: MemoryRecord): boolean {
  return !stringValue(record.metadata?.lastImportedAt) || record.content.includes("\n\nTranscript:\n");
}

function summaryForSession(agentLabel: string, session: ImportedSession, rollingSummary?: string): string {
  const cwdName = session.cwd ? basename(session.cwd) : "session";
  const summary = rollingSummary?.trim() || session.messages.find((message) => message.role === "user")?.content || session.id;
  return clamp(`${agentLabel} session in ${cwdName}: ${summary}`, 220);
}

function sessionRecordContent(agentLabel: string, agentKey: string, session: ImportedSession, rollingSummary?: string): string {
  const header = [
    `${agentLabel} session: ${session.id}`,
    session.timestamp ? `Started: ${session.timestamp}` : "",
    session.cwd ? `Working directory: ${session.cwd}` : "",
    `Task id: ${taskIdForSession(agentKey, session.id)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const summary =
    rollingSummary?.trim() ||
    session.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  return `${header}\n\nSession summary:\n${summary}`;
}

function sessionRecordMetadata(input: {
  session: ImportedSession;
  taskId: string;
  previous?: Record<string, unknown>;
  resumed: boolean;
}): Record<string, unknown> {
  const previous = asObject(input.previous);
  const previousResumeCount = numberValue(previous.resumeCount) ?? 0;
  return {
    ...input.session.metadata,
    sessionId: input.session.id,
    sessionPath: input.session.path,
    cwd: input.session.cwd,
    timestamp: input.session.timestamp,
    taskId: input.taskId,
    messageCount: input.session.messages.length,
    lastMessageHash: hashSessionMessage(input.session.messages.at(-1)),
    lastImportedAt: new Date().toISOString(),
    resumeCount: previousResumeCount + (input.resumed ? 1 : 0),
  };
}

function hashSessionMessage(message: ImportedSessionMessage | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  return createHash("sha256").update(`${message.role}\0${message.content}`).digest("hex").slice(0, 16);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
