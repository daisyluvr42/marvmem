import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarvMem } from "../src/core/index.js";

test("Claude import CLI stores Claude Code JSONL sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-claude-import-"));
  const sessionsRoot = join(root, ".claude", "projects", "-Users-test-project");
  const storagePath = join(root, "memory.sqlite");
  const sessionPath = join(sessionsRoot, "claude-session.jsonl");

  try {
    await mkdir(sessionsRoot, { recursive: true });
    await writeFile(
      sessionPath,
      [
        jsonl({
          type: "queue-operation",
          sessionId: "claude-session",
          timestamp: "2026-05-01T00:00:00.000Z",
          content: "Queued prompt",
        }),
        jsonl({
          type: "user",
          sessionId: "claude-session",
          timestamp: "2026-05-01T00:00:01.000Z",
          cwd: "/Users/test/project",
          message: { role: "user", content: "Remember the Claude importer shape." },
        }),
        jsonl({
          type: "assistant",
          sessionId: "claude-session",
          timestamp: "2026-05-01T00:00:02.000Z",
          cwd: "/Users/test/project",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private scratch" },
              { type: "text", text: "Claude importer stores only visible text." },
              { type: "tool_use", name: "Read" },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await runImporter("src/bin/marvmem-claude-import.ts", sessionsRoot, storagePath, "claude-test");

    const memory = createMarvMem({ storagePath });
    const entries = await memory.task.listEntries("claude:claude-session");
    assert.equal(entries.length, 2);
    assert.match(entries[0]?.content ?? "", /Claude importer shape/);
    assert.match(entries[1]?.content ?? "", /visible text/);
    assert.doesNotMatch(entries[1]?.content ?? "", /private scratch/);

    const records = await memory.list({ scopes: [{ type: "agent", id: "claude-test" }] });
    assert.equal(records[0]?.source, "claude_session_import");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Copilot import CLI stores VS Code chat session JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-copilot-import-"));
  const sessionsRoot = join(root, "Code", "User");
  const workspaceRoot = join(sessionsRoot, "workspaceStorage", "workspace-1");
  const chatDir = join(workspaceRoot, "chatSessions");
  const storagePath = join(root, "memory.sqlite");
  const sessionPath = join(chatDir, "copilot-session.json");

  try {
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(workspaceRoot, "workspace.json"), JSON.stringify({ folder: "file:///Users/test/copilot" }), "utf8");
    await writeFile(
      sessionPath,
      JSON.stringify({
        sessionId: "copilot-session",
        creationDate: 1770000000000,
        requests: [
          {
            message: { text: "Check the Copilot importer." },
            response: [{ value: "Copilot importer reads response text." }],
          },
        ],
      }),
      "utf8",
    );

    await runImporter("src/bin/marvmem-copilot-import.ts", sessionsRoot, storagePath, "copilot-test");

    const memory = createMarvMem({ storagePath });
    const task = await memory.task.get("copilot:copilot-session");
    assert.equal(task?.scope.id, "copilot-test");
    const entries = await memory.task.listEntries("copilot:copilot-session");
    assert.equal(entries.length, 2);
    assert.match(entries[0]?.content ?? "", /Copilot importer/);
    assert.match(entries[1]?.content ?? "", /response text/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor import CLI stores composer sessions from Cursor state database", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-cursor-import-"));
  const sessionsRoot = join(root, "Cursor", "User");
  const globalStorage = join(sessionsRoot, "globalStorage");
  const storagePath = join(root, "memory.sqlite");
  const dbPath = join(globalStorage, "state.vscdb");

  try {
    await mkdir(globalStorage, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "composerData:cursor-session",
      JSON.stringify({
        composerId: "cursor-session",
        createdAt: 1770000000000,
        conversationMap: {
          a: { role: "user", text: "Import this Cursor composer.", createdAt: 1 },
          b: { role: "assistant", text: "Cursor importer found composer text.", createdAt: 2 },
        },
      }),
    );
    db.close();

    await runImporter("src/bin/marvmem-cursor-import.ts", sessionsRoot, storagePath, "cursor-test");

    const memory = createMarvMem({ storagePath });
    const entries = await memory.task.listEntries("cursor:cursor-session");
    assert.equal(entries.length, 2);
    assert.match(entries[0]?.content ?? "", /Cursor composer/);
    assert.match(entries[1]?.content ?? "", /composer text/);

    const records = await memory.list({ scopes: [{ type: "agent", id: "cursor-test" }] });
    assert.equal(records[0]?.source, "cursor_session_import");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Antigravity import CLI stores brain session artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-antigravity-import-"));
  const sessionsRoot = join(root, ".gemini", "antigravity", "brain");
  const sessionRoot = join(sessionsRoot, "antigravity-session");
  const storagePath = join(root, "memory.sqlite");

  try {
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(
      join(sessionRoot, "task.md"),
      "# Task Plan\n- [x] Import Antigravity brain artifacts.",
      "utf8",
    );
    await writeFile(
      join(sessionRoot, "task.md.metadata.json"),
      JSON.stringify({
        summary: "Task plan for importing Antigravity artifacts.",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
      "utf8",
    );
    await writeFile(
      join(sessionRoot, "walkthrough.md"),
      "# Walkthrough\nAntigravity importer reads markdown artifacts.",
      "utf8",
    );
    await writeFile(
      join(sessionRoot, "walkthrough.md.metadata.json"),
      JSON.stringify({
        summary: "Walkthrough for the importer.",
        updatedAt: "2026-05-01T00:01:00.000Z",
      }),
      "utf8",
    );

    await runImporter("src/bin/marvmem-antigravity-import.ts", sessionsRoot, storagePath, "antigravity-test");

    const memory = createMarvMem({ storagePath });
    const entries = await memory.task.listEntries("antigravity:antigravity-session");
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.role, "user");
    assert.match(entries[0]?.content ?? "", /Import Antigravity/);
    assert.match(entries[1]?.content ?? "", /markdown artifacts/);

    const records = await memory.list({ scopes: [{ type: "agent", id: "antigravity-test" }] });
    assert.equal(records[0]?.source, "antigravity_session_import");
    assert.equal(records[0]?.metadata?.artifactCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function jsonl(value: unknown): string {
  return JSON.stringify(value);
}

async function runImporter(script: string, sessionsRoot: string, storagePath: string, scopeId: string): Promise<void> {
  await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    join(process.cwd(), script),
    sessionsRoot,
    "--storage-path",
    storagePath,
    "--scope-type",
    "agent",
    "--scope-id",
    scopeId,
  ]);
}

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
