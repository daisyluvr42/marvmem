#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { createMarvMem } from "../core/index.js";
import type { MemoryScope } from "../core/types.js";
import {
  applyHermesMemoryWrite,
  createHermesAgentMemoryAdapter,
} from "../adapters/hermes-agent.js";

type Command =
  | "sync-home"
  | "after-turn"
  | "flush-session"
  | "memory-write"
  | "install-plugin";

type CliOptions = {
  action?: "add" | "replace" | "remove";
  command: Command;
  assistantMessage?: string;
  content?: string;
  hermesHome: string;
  oldText?: string;
  scope: MemoryScope;
  sessionId?: string;
  storagePath: string;
  target?: "memory" | "user";
  userMessage?: string;
};

const HELP = `marvmem-hermes

Bridge Hermes sessions into MarvMem.

Commands:
  sync-home       Import Hermes memory files into MarvMem if needed, then write the current projection back
  after-turn      Record a completed Hermes turn and refresh Hermes memory files
  flush-session   Run session-level summarization and refresh Hermes memory files
  memory-write    Mirror a Hermes memory tool write into MarvMem and refresh Hermes memory files
  install-plugin  Install a Hermes plugin that calls this bridge after turns and at session boundaries

Shared options:
  --hermes-home <path>    Hermes home directory (default: ~/.hermes)
  --storage-path <path>   MarvMem SQLite path (default: <hermes-home>/marvmem.sqlite)
  --scope-type <type>     Scope type (default: agent)
  --scope-id <id>         Scope id (default: hermes)

Command options:
  after-turn:
    --session-id <id>
    --user-message <text>
    --assistant-message <text>

  flush-session:
    --session-id <id>

  memory-write:
    --target <memory|user>
    --action <add|replace|remove>
    --content <text>
    --old-text <text>

Environment:
  MARVMEM_HERMES_HOME
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID
`;

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2), process.env);
  if (options.command === "install-plugin") {
    await installPlugin(options);
    return;
  }

  const memory = createMarvMem({ storagePath: options.storagePath });
  const adapter = createHermesAgentMemoryAdapter({
    memory,
    defaultScopes: [options.scope],
    files: resolveHermesFiles(options.hermesHome),
  });

  if (options.command === "sync-home") {
    const existing = await memory.list({ scopes: [options.scope], limit: 1 });
    if (existing.length === 0) {
      await adapter.importExistingMemory();
    }
    await adapter.syncProjection();
    return;
  }

  if (options.command === "after-turn") {
    await adapter.afterTurn({
      userMessage: options.userMessage ?? "",
      assistantMessage: options.assistantMessage ?? "",
    });
    return;
  }

  if (options.command === "flush-session") {
    await adapter.flushSession();
    return;
  }

  if (!options.target) {
    throw new Error("memory-write requires --target");
  }
  await applyHermesMemoryWrite({
    memory,
    scopes: [options.scope],
    action: options.action ?? readAction(process.argv.slice(2)),
    target: options.target,
    content: options.content,
    oldText: options.oldText,
  });
  await adapter.syncProjection();
}

function parseCli(argv: string[], env: NodeJS.ProcessEnv): CliOptions {
  const command = argv[0];
  if (!command || command === "--help") {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }
  if (
    command !== "sync-home" &&
    command !== "after-turn" &&
    command !== "flush-session" &&
    command !== "memory-write" &&
    command !== "install-plugin"
  ) {
    throw new Error(`Unknown command: ${command}`);
  }

  let hermesHome = env.MARVMEM_HERMES_HOME ?? join(homedir(), ".hermes");
  let storagePath = env.MARVMEM_STORAGE_PATH;
  let scopeType = env.MARVMEM_SCOPE_TYPE ?? "agent";
  let scopeId = env.MARVMEM_SCOPE_ID ?? "hermes";
  let sessionId: string | undefined;
  let userMessage: string | undefined;
  let assistantMessage: string | undefined;
  let action: "add" | "replace" | "remove" | undefined;
  let target: "memory" | "user" | undefined;
  let content: string | undefined;
  let oldText: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--hermes-home") {
      hermesHome = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--storage-path") {
      storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-type") {
      scopeType = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--scope-id") {
      scopeId = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--session-id") {
      sessionId = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--user-message") {
      userMessage = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--assistant-message") {
      assistantMessage = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--target") {
      const value = readFlagValue(argv, ++index, arg);
      if (value !== "memory" && value !== "user") {
        throw new Error(`Unsupported target: ${value}`);
      }
      target = value;
      continue;
    }
    if (arg === "--action") {
      const value = readFlagValue(argv, ++index, arg);
      if (value !== "add" && value !== "replace" && value !== "remove") {
        throw new Error(`Unsupported action: ${value}`);
      }
      action = value;
      continue;
    }
    if (arg === "--content") {
      content = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--old-text") {
      oldText = readFlagValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    action,
    command,
    assistantMessage,
    content,
    hermesHome,
    oldText,
    scope: {
      type: scopeType as MemoryScope["type"],
      id: scopeId,
    },
    sessionId,
    storagePath: storagePath ?? join(hermesHome, "marvmem.sqlite"),
    target,
    userMessage,
  };
}

function readAction(argv: string[]): "add" | "replace" | "remove" {
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== "--action") {
      continue;
    }
    const value = readFlagValue(argv, index + 1, "--action");
    if (value === "add" || value === "replace" || value === "remove") {
      return value;
    }
    throw new Error(`Unsupported action: ${value}`);
  }
  throw new Error("memory-write requires --action");
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function resolveHermesFiles(hermesHome: string) {
  return {
    memoryPath: join(hermesHome, "memories", "MEMORY.md"),
    userPath: join(hermesHome, "memories", "USER.md"),
  };
}

async function installPlugin(options: CliOptions): Promise<void> {
  const pluginDir = join(options.hermesHome, "plugins", "marvmem");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "plugin.yaml"), buildPluginManifest(), "utf8");
  await writeFile(
    join(pluginDir, "__init__.py"),
    buildPluginModule({
      hermesHome: options.hermesHome,
      storagePath: options.storagePath,
      scope: options.scope,
    }),
    "utf8",
  );

  const memory = createMarvMem({ storagePath: options.storagePath });
  const adapter = createHermesAgentMemoryAdapter({
    memory,
    defaultScopes: [options.scope],
    files: resolveHermesFiles(options.hermesHome),
  });
  const existing = await memory.list({ scopes: [options.scope], limit: 1 });
  if (existing.length === 0) {
    await adapter.importExistingMemory();
  }
  await adapter.syncProjection();
}

function buildPluginManifest(): string {
  return `name: marvmem
version: "1.0"
description: Keep Hermes memory files in sync with MarvMem
provides_hooks:
  - post_llm_call
  - post_tool_call
  - on_session_finalize
`;
}

function buildPluginModule(input: {
  hermesHome: string;
  storagePath: string;
  scope: MemoryScope;
}): string {
  const bridgePath = realpathSync(fileURLToPath(import.meta.url));
  const nodePath = process.execPath;
  return `import json
import logging
import subprocess

logger = logging.getLogger(__name__)

NODE = ${JSON.stringify(nodePath)}
BRIDGE = ${JSON.stringify(bridgePath)}
HERMES_HOME = ${JSON.stringify(input.hermesHome)}
STORAGE_PATH = ${JSON.stringify(input.storagePath)}
SCOPE_TYPE = ${JSON.stringify(input.scope.type)}
SCOPE_ID = ${JSON.stringify(input.scope.id)}

def _run(*args):
    try:
        subprocess.run(
            [NODE, BRIDGE, *args],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as exc:
        logger.warning("marvmem bridge failed: %s", exc)

def _base_args():
    return [
        "--hermes-home", HERMES_HOME,
        "--storage-path", STORAGE_PATH,
        "--scope-type", SCOPE_TYPE,
        "--scope-id", SCOPE_ID,
    ]

def post_llm_call(session_id="", user_message="", assistant_response="", **kwargs):
    if not user_message and not assistant_response:
        return
    _run(
        "after-turn",
        *_base_args(),
        "--session-id", session_id or "",
        "--user-message", user_message or "",
        "--assistant-message", assistant_response or "",
    )

def post_tool_call(tool_name="", args=None, result="", **kwargs):
    if tool_name != "memory" or not isinstance(args, dict):
        return
    try:
        parsed = json.loads(result or "{}")
    except Exception:
        return
    if not parsed.get("success"):
        return
    action = str(args.get("action", "") or "")
    target = str(args.get("target", "memory") or "memory")
    if action not in {"add", "replace", "remove"} or target not in {"memory", "user"}:
        return
    command = [
        "memory-write",
        *_base_args(),
        "--action", action,
        "--target", target,
    ]
    content = str(args.get("content", "") or "")
    old_text = str(args.get("old_text", "") or "")
    if content:
        command.extend(["--content", content])
    if old_text:
        command.extend(["--old-text", old_text])
    _run(*command)

def on_session_finalize(session_id=None, **kwargs):
    if not session_id:
        return
    _run(
        "flush-session",
        *_base_args(),
        "--session-id", session_id,
    )

def register(ctx):
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_hook("post_tool_call", post_tool_call)
    ctx.register_hook("on_session_finalize", on_session_finalize)
`;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
