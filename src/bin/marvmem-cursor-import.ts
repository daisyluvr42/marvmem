#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import {
  asObject,
  findFiles,
  isoFromTimestamp,
  parseImportOptions,
  readJsonFile,
  readWorkspaceFolderFromChatSession,
  runSessionImport,
  stringValue,
  textFromVsCodeResponse,
  type ImportedSession,
  type SessionImportReadResult,
} from "./session-import.js";

const HELP = `marvmem-cursor-import

Import Cursor chat/composer sessions into MarvMem.

Usage:
  marvmem-cursor-import [sessions-root]

Options:
  --storage-path <path>  SQLite database path (default: ${defaultMemoryMcpStoragePath()})
  --scope-type <type>    Target scope type (default: agent)
  --scope-id <id>        Target scope id (default: cursor)
  --help                 Show this message

Environment:
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID

Default sessions root:
  ~/Library/Application Support/Cursor/User
`;

async function main(): Promise<void> {
  const options = parseImportOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultRoot: join(homedir(), "Library", "Application Support", "Cursor", "User"),
    defaultStoragePath: defaultMemoryMcpStoragePath(),
    defaultScopeId: "cursor",
    help: HELP,
  });
  await runSessionImport({
    agentKey: "cursor",
    agentLabel: "Cursor",
    options,
    readSessions: readCursorSessions,
  });
}

async function readCursorSessions(root: string): Promise<SessionImportReadResult> {
  const chatFiles = await findFiles(root, (path, name) => name.endsWith(".json") && path.toLowerCase().includes("chatsessions"));
  const dbFiles = await findFiles(root, (_path, name) => name === "state.vscdb");
  const chatSessions = (await Promise.all(chatFiles.map(readCursorChatSession))).filter((session): session is ImportedSession => !!session);
  const composerSessions = dbFiles.flatMap(readComposerSessionsFromDatabase);
  return {
    files: chatFiles.length + dbFiles.length,
    sessions: [...chatSessions, ...composerSessions],
  };
}

async function readCursorChatSession(path: string): Promise<ImportedSession | null> {
  const data = asObject(await readJsonFile(path));
  const id = stringValue(data.sessionId);
  if (!id) {
    return null;
  }
  const messages: ImportedSession["messages"] = [];
  for (const request of Array.isArray(data.requests) ? data.requests : []) {
    const item = asObject(request);
    const message = asObject(item.message);
    const userText = stringValue(message.text);
    if (userText) {
      messages.push({ role: "user", content: userText });
    }
    const assistantText = textFromVsCodeResponse(item.response).trim();
    if (assistantText) {
      messages.push({ role: "assistant", content: assistantText });
    }
  }

  return {
    path,
    id,
    timestamp: isoFromTimestamp(data.creationDate),
    cwd: await readWorkspaceFolderFromChatSession(path),
    messages,
  };
}

function readComposerSessionsFromDatabase(path: string): ImportedSession[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
      .all() as Array<{ key: string; value: string | Uint8Array }>;
    return rows.map((row) => readComposerSession(path, row)).filter((session): session is ImportedSession => !!session);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function readComposerSession(path: string, row: { key: string; value: string | Uint8Array }): ImportedSession | null {
  const text = typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
  const data = asObject(JSON.parse(text));
  const id = stringValue(data.composerId) ?? row.key.slice("composerData:".length);
  const conversation = asObject(data.conversationMap);
  const messages = Object.values(conversation)
    .map(readCursorConversationMessage)
    .filter((message): message is ImportedSession["messages"][number] & { timestamp?: number } => !!message)
    .toSorted((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
    .map(({ role, content }) => ({ role, content }));
  return {
    path,
    id,
    timestamp: isoFromTimestamp(data.createdAt),
    messages,
  };
}

function readCursorConversationMessage(value: unknown): (ImportedSession["messages"][number] & { timestamp?: number }) | null {
  const record = asObject(value);
  const rawRole = stringValue(record.role) ?? stringValue(record.type) ?? stringValue(record.speaker);
  const role = rawRole === "user" || rawRole === "human" ? "user" : rawRole === "assistant" || rawRole === "ai" ? "assistant" : null;
  if (!role) {
    return null;
  }
  const content =
    stringValue(record.text) ??
    stringValue(record.content) ??
    stringValue(record.message) ??
    stringValue(asObject(record.message).text);
  if (!content) {
    return null;
  }
  return {
    role,
    content,
    timestamp: typeof record.createdAt === "number" ? record.createdAt : typeof record.timestamp === "number" ? record.timestamp : undefined,
  };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
