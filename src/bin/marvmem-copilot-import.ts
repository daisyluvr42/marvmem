#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
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

const HELP = `marvmem-copilot-import

Import VS Code / GitHub Copilot chat session JSON files into MarvMem.

Usage:
  marvmem-copilot-import [sessions-root]

Options:
  --storage-path <path>  SQLite database path (default: ${defaultMemoryMcpStoragePath()})
  --scope-type <type>    Target scope type (default: agent)
  --scope-id <id>        Target scope id (default: copilot)
  --help                 Show this message

Environment:
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID

Default sessions root:
  ~/Library/Application Support/Code/User
`;

async function main(): Promise<void> {
  const options = parseImportOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultRoot: join(homedir(), "Library", "Application Support", "Code", "User"),
    defaultStoragePath: defaultMemoryMcpStoragePath(),
    defaultScopeId: "copilot",
    help: HELP,
  });
  await runSessionImport({
    agentKey: "copilot",
    agentLabel: "Copilot",
    options,
    readSessions: readCopilotSessions,
  });
}

async function readCopilotSessions(root: string): Promise<SessionImportReadResult> {
  const files = await findFiles(root, (path, name) => name.endsWith(".json") && path.toLowerCase().includes("chatsessions"));
  const sessions = (await Promise.all(files.map(readCopilotSession))).filter((session): session is ImportedSession => !!session);
  return { files: files.length, sessions };
}

async function readCopilotSession(path: string): Promise<ImportedSession | null> {
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

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
