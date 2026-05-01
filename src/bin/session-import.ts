import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMarvMem } from "../core/index.js";
import type { MemoryScope, MemoryScopeType } from "../core/types.js";

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
  let skipped = 0;
  let messages = 0;

  for (const session of result.sessions) {
    if (session.messages.length === 0 || !session.messages.some((message) => message.role === "user")) {
      skipped += 1;
      continue;
    }

    const taskId = taskIdForSession(input.agentKey, session.id);
    const existing = await memory.task.get(taskId);
    if (existing) {
      skipped += 1;
      continue;
    }

    await memory.task.create({
      taskId,
      scope: input.options.scope,
      title: titleForSession(input.agentLabel, session),
      status: "completed",
    });
    for (const message of session.messages) {
      await memory.task.appendEntry({
        taskId,
        role: message.role,
        content: message.content,
      });
    }
    await memory.remember({
      scope: input.options.scope,
      kind: "note",
      content: sessionRecordContent(input.agentLabel, input.agentKey, session),
      summary: summaryForSession(input.agentLabel, session),
      confidence: 0.9,
      importance: 0.6,
      source: `${input.agentKey}_session_import`,
      tags: [input.agentKey, "session"],
      metadata: {
        sessionId: session.id,
        sessionPath: session.path,
        cwd: session.cwd,
        timestamp: session.timestamp,
        taskId,
        messageCount: session.messages.length,
        ...session.metadata,
      },
    });

    imported += 1;
    messages += session.messages.length;
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

function summaryForSession(agentLabel: string, session: ImportedSession): string {
  const cwdName = session.cwd ? basename(session.cwd) : "session";
  const firstUser = session.messages.find((message) => message.role === "user")?.content ?? session.id;
  return clamp(`${agentLabel} session in ${cwdName}: ${firstUser}`, 220);
}

function sessionRecordContent(agentLabel: string, agentKey: string, session: ImportedSession): string {
  const header = [
    `${agentLabel} session: ${session.id}`,
    session.timestamp ? `Started: ${session.timestamp}` : "",
    session.cwd ? `Working directory: ${session.cwd}` : "",
    `Task id: ${taskIdForSession(agentKey, session.id)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const transcript = session.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
  return `${header}\n\nTranscript:\n${transcript}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
