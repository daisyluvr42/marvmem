import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarvMem } from "../src/core/index.js";

test("Codex import CLI stores session messages as task context and searchable memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "marvmem-codex-import-"));
  const sessionsRoot = join(root, "sessions");
  const sessionDir = join(sessionsRoot, "2026", "05", "01");
  const storagePath = join(root, "memory.sqlite");
  const sessionPath = join(sessionDir, "rollout-2026-05-01T00-00-00-session-1.jsonl");

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionPath,
      [
        jsonl({
          type: "session_meta",
          payload: {
            id: "session-1",
            timestamp: "2026-05-01T00:00:00.000Z",
            cwd: "/Users/daisyluvr/Documents/marvmem",
          },
        }),
        jsonl({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /Users/daisyluvr/Documents/marvmem\n<environment_context></environment_context>",
              },
            ],
          },
        }),
        jsonl({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Remember that Codex imports should stay simple." }],
          },
        }),
        jsonl({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
          },
        }),
        jsonl({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Got it. I will keep the importer narrow." }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-codex-import.ts"),
      sessionsRoot,
      "--storage-path",
      storagePath,
      "--scope-type",
      "agent",
      "--scope-id",
      "codex-test",
    ]);

    const memory = createMarvMem({ storagePath });
    const task = await memory.task.get("codex:session-1");
    assert.ok(task);
    assert.equal(task.status, "completed");

    const entries = await memory.task.listEntries("codex:session-1");
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.role, "user");
    assert.match(entries[0]?.content ?? "", /Codex imports should stay simple/);
    assert.equal(entries[1]?.role, "assistant");
    assert.match(entries[1]?.content ?? "", /importer narrow/);

    const records = await memory.list({
      scopes: [{ type: "agent", id: "codex-test" }],
    });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.source, "codex_session_import");
    assert.match(records[0]?.content ?? "", /Codex session: session-1/);
    assert.match(records[0]?.content ?? "", /Remember that Codex imports should stay simple/);
    assert.doesNotMatch(records[0]?.content ?? "", /AGENTS\.md instructions/);

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      join(process.cwd(), "src/bin/marvmem-codex-import.ts"),
      sessionsRoot,
      "--storage-path",
      storagePath,
      "--scope-type",
      "agent",
      "--scope-id",
      "codex-test",
    ]);

    const rerunEntries = await memory.task.listEntries("codex:session-1");
    const rerunRecords = await memory.list({
      scopes: [{ type: "agent", id: "codex-test" }],
    });
    assert.equal(rerunEntries.length, 2);
    assert.equal(rerunRecords.length, 1);

    const output = await readFile(storagePath, "utf8").catch(() => "");
    assert.equal(typeof output, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function jsonl(value: unknown): string {
  return JSON.stringify(value);
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
