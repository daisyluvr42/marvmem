#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import {
  asObject,
  clamp,
  parseImportOptions,
  runSessionImport,
  stringValue,
  type ImportedSession,
  type SessionImportReadResult,
} from "./session-import.js";

type AntigravityArtifact = {
  name: string;
  path: string;
  summary?: string;
  updatedAt?: string;
  content: string;
};

const HELP = `marvmem-antigravity-import

Import Google Antigravity brain session artifacts into MarvMem.

Usage:
  marvmem-antigravity-import [brain-root]

Options:
  --storage-path <path>  SQLite database path (default: ${defaultMemoryMcpStoragePath()})
  --scope-type <type>    Target scope type (default: agent)
  --scope-id <id>        Target scope id (default: antigravity)
  --help                 Show this message

Environment:
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID

Default sessions root:
  ~/.gemini/antigravity/brain
`;

async function main(): Promise<void> {
  const options = parseImportOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultRoot: join(homedir(), ".gemini", "antigravity", "brain"),
    defaultStoragePath: defaultMemoryMcpStoragePath(),
    defaultScopeId: "antigravity",
    help: HELP,
  });
  await runSessionImport({
    agentKey: "antigravity",
    agentLabel: "Antigravity",
    options,
    readSessions: readAntigravitySessions,
  });
}

async function readAntigravitySessions(root: string): Promise<SessionImportReadResult> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { files: 0, sessions: [] };
    }
    throw error;
  }

  const sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort();
  const sessions = (await Promise.all(sessionDirs.map(readAntigravitySession))).filter(
    (session): session is ImportedSession => !!session,
  );
  const files = sessions.reduce((count, session) => count + ((session.metadata?.artifactCount as number | undefined) ?? 0), 0);
  return { files, sessions };
}

async function readAntigravitySession(path: string): Promise<ImportedSession | null> {
  const entries = await readdir(path, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(path, entry.name))
    .sort(compareArtifactPath);
  const artifacts = (await Promise.all(markdownFiles.map(readArtifact))).filter(
    (artifact): artifact is AntigravityArtifact => !!artifact,
  );
  if (artifacts.length === 0) {
    return null;
  }

  const task = artifacts.find((artifact) => artifact.name === "task.md") ?? artifacts[0]!;
  const otherArtifacts = artifacts.filter((artifact) => artifact.path !== task.path);
  const messages: ImportedSession["messages"] = [
    {
      role: "user",
      content: formatArtifact(task),
    },
    ...otherArtifacts.map((artifact) => ({
      role: "assistant" as const,
      content: formatArtifact(artifact),
    })),
  ];
  const artifactMetadata = artifacts.map((artifact) => ({
    name: artifact.name,
    path: artifact.path,
    summary: artifact.summary,
    updatedAt: artifact.updatedAt,
  }));

  return {
    path,
    id: basename(path),
    timestamp: latestTimestamp(artifacts),
    messages,
    metadata: {
      artifactCount: artifacts.length,
      artifacts: artifactMetadata,
    },
  };
}

async function readArtifact(path: string): Promise<AntigravityArtifact | null> {
  const content = (await readFile(path, "utf8")).trim();
  if (!content) {
    return null;
  }
  const metadata = asObject(await readArtifactMetadata(path));
  return {
    name: basename(path),
    path,
    summary: stringValue(metadata.summary),
    updatedAt: stringValue(metadata.updatedAt),
    content,
  };
}

async function readArtifactMetadata(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(`${path}.metadata.json`, "utf8"));
  } catch {
    return {};
  }
}

function formatArtifact(artifact: AntigravityArtifact): string {
  return [
    `Artifact: ${artifact.name}`,
    artifact.summary ? `Summary: ${artifact.summary}` : "",
    artifact.updatedAt ? `Updated: ${artifact.updatedAt}` : "",
    "",
    clamp(artifact.content, 12_000),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function compareArtifactPath(left: string, right: string): number {
  const leftName = basename(left);
  const rightName = basename(right);
  if (leftName === "task.md") {
    return -1;
  }
  if (rightName === "task.md") {
    return 1;
  }
  return leftName.localeCompare(rightName);
}

function latestTimestamp(artifacts: AntigravityArtifact[]): string | undefined {
  return artifacts
    .map((artifact) => artifact.updatedAt)
    .filter((value): value is string => !!value)
    .sort()
    .at(-1);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
