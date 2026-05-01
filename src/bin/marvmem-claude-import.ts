#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import {
  asObject,
  findFiles,
  parseImportOptions,
  runSessionImport,
  stringValue,
  textFromContent,
  type ImportedSession,
  type SessionImportReadResult,
} from "./session-import.js";

const HELP = `marvmem-claude-import

Import Claude Code session JSONL files into MarvMem.

Usage:
  marvmem-claude-import [sessions-root]

Options:
  --storage-path <path>  SQLite database path (default: ${defaultMemoryMcpStoragePath()})
  --scope-type <type>    Target scope type (default: agent)
  --scope-id <id>        Target scope id (default: claude)
  --help                 Show this message

Environment:
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID

Default sessions root:
  ~/.claude/projects
`;

async function main(): Promise<void> {
  const options = parseImportOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultRoot: join(homedir(), ".claude", "projects"),
    defaultStoragePath: defaultMemoryMcpStoragePath(),
    defaultScopeId: "claude",
    help: HELP,
  });
  await runSessionImport({
    agentKey: "claude",
    agentLabel: "Claude Code",
    options,
    readSessions: readClaudeSessions,
  });
}

async function readClaudeSessions(root: string): Promise<SessionImportReadResult> {
  const files = await findFiles(root, (_path, name) => name.endsWith(".jsonl"));
  const sessions = (await Promise.all(files.map(readClaudeSession))).filter((session): session is ImportedSession => !!session);
  return { files: files.length, sessions };
}

async function readClaudeSession(path: string): Promise<ImportedSession | null> {
  const content = await readFile(path, "utf8");
  let id = basename(path, ".jsonl");
  let timestamp: string | undefined;
  let cwd: string | undefined;
  const messages: ImportedSession["messages"] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const record = JSON.parse(trimmed) as Record<string, unknown>;
    const type = stringValue(record.type);
    if (type !== "user" && type !== "assistant") {
      continue;
    }
    id = stringValue(record.sessionId) ?? id;
    timestamp ??= stringValue(record.timestamp);
    cwd ??= stringValue(record.cwd);

    const message = asObject(record.message);
    const text = textFromContent(message.content).trim();
    if (!text) {
      continue;
    }
    messages.push({ role: type, content: text });
  }

  return { path, id, timestamp, cwd, messages };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
