#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

const HELP = `marvmem-codex-import

Import Codex Desktop session JSONL files into MarvMem.

Usage:
  marvmem-codex-import [sessions-root]

Options:
  --storage-path <path>  SQLite database path (default: ${defaultMemoryMcpStoragePath()})
  --scope-type <type>    Target scope type (default: agent)
  --scope-id <id>        Target scope id (default: codex)
  --help                 Show this message

Environment:
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID

Default sessions root:
  ~/.codex/sessions
`;

async function main(): Promise<void> {
  const options = parseImportOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultRoot: join(homedir(), ".codex", "sessions"),
    defaultStoragePath: defaultMemoryMcpStoragePath(),
    defaultScopeId: "codex",
    help: HELP,
  });
  await runSessionImport({
    agentKey: "codex",
    agentLabel: "Codex",
    options,
    readSessions: readCodexSessions,
  });
}

async function readCodexSessions(root: string): Promise<SessionImportReadResult> {
  const files = await findFiles(root, (_path, name) => name.startsWith("rollout-") && name.endsWith(".jsonl"));
  const sessions = (await Promise.all(files.map(readCodexSession))).filter((session): session is ImportedSession => !!session);
  return { files: files.length, sessions };
}

async function readCodexSession(path: string): Promise<ImportedSession | null> {
  const content = await readFile(path, "utf8");
  let id = "";
  let timestamp: string | undefined;
  let cwd: string | undefined;
  const messages: ImportedSession["messages"] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const record = JSON.parse(trimmed) as Record<string, unknown>;
    if (record.type === "session_meta") {
      const payload = asObject(record.payload);
      id = stringValue(payload.id) ?? id;
      timestamp = stringValue(payload.timestamp);
      cwd = stringValue(payload.cwd);
      continue;
    }
    if (record.type !== "response_item") {
      continue;
    }

    const payload = asObject(record.payload);
    if (payload.type !== "message") {
      continue;
    }
    const role = stringValue(payload.role);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = textFromContent(payload.content).trim();
    if (!text || (role === "user" && isBootstrapUserMessage(text))) {
      continue;
    }
    messages.push({ role, content: text });
  }

  if (!id) {
    return null;
  }
  return { path, id, timestamp, cwd, messages };
}

function isBootstrapUserMessage(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("# AGENTS.md instructions for ") || trimmed.startsWith("<environment_context>");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
