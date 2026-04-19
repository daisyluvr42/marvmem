#!/usr/bin/env node

import type { MemoryScope } from "../core/types.js";
import { defaultMemoryMcpStoragePath, runMemoryMcpStdioServer } from "../mcp/stdio.js";
import type { MarvMemOptions } from "../core/memory.js";

type CliConfig = {
  defaultScopes?: MemoryScope[];
  retrieval?: MarvMemOptions["retrieval"];
  storagePath?: string;
};

type RetrievalConfig = NonNullable<MarvMemOptions["retrieval"]>;
type RetrievalBackend = NonNullable<RetrievalConfig["backend"]>;
type EmbeddingsConfig = NonNullable<RetrievalConfig["embeddings"]>;

const HELP = `marvmem-mcp

Local stdio MCP server for MarvMem.

Options:
  --storage-path <path>          Override the SQLite database path
  --scope-type <type>            Set a default scope type for all tools
  --scope-id <id>                Set a default scope id for all tools
  --retrieval-backend <name>     builtin | qmd
  --embeddings-provider <name>   openai | gemini | voyage | script | auto
  --embeddings-model <name>      Override the remote embeddings model
  --embeddings-base-url <url>    Override the remote embeddings base URL
  --qmd-command <command>        Override the qmd command when backend=qmd
  --help                         Show this message

Environment:
  MARVMEM_STORAGE_PATH
  MARVMEM_SCOPE_TYPE
  MARVMEM_SCOPE_ID
  MARVMEM_RETRIEVAL_BACKEND
  MARVMEM_EMBEDDINGS_PROVIDER
  MARVMEM_EMBEDDINGS_MODEL
  MARVMEM_EMBEDDINGS_BASE_URL
  MARVMEM_QMD_COMMAND

Defaults:
  storage path: ${defaultMemoryMcpStoragePath()}
`;

async function main(): Promise<void> {
  const config = parseCliConfig(process.argv.slice(2), process.env);
  await runMemoryMcpStdioServer(config);
}

function parseCliConfig(argv: string[], env: NodeJS.ProcessEnv): CliConfig {
  let storagePath = env.MARVMEM_STORAGE_PATH;
  let scopeType = env.MARVMEM_SCOPE_TYPE;
  let scopeId = env.MARVMEM_SCOPE_ID;
  let retrievalBackend = env.MARVMEM_RETRIEVAL_BACKEND;
  let embeddingsProvider = env.MARVMEM_EMBEDDINGS_PROVIDER;
  let embeddingsModel = env.MARVMEM_EMBEDDINGS_MODEL;
  let embeddingsBaseUrl = env.MARVMEM_EMBEDDINGS_BASE_URL;
  let qmdCommand = env.MARVMEM_QMD_COMMAND;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
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
    if (arg === "--retrieval-backend") {
      retrievalBackend = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--embeddings-provider") {
      embeddingsProvider = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--embeddings-model") {
      embeddingsModel = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--embeddings-base-url") {
      embeddingsBaseUrl = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--qmd-command") {
      qmdCommand = readFlagValue(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if ((scopeType && !scopeId) || (!scopeType && scopeId)) {
    throw new Error("Default scope requires both --scope-type and --scope-id");
  }

  const defaultScopes = scopeType && scopeId ? [{ type: scopeType as MemoryScope["type"], id: scopeId }] : undefined;
  const retrieval = buildRetrievalConfig({
    retrievalBackend,
    embeddingsProvider,
    embeddingsModel,
    embeddingsBaseUrl,
    qmdCommand,
  });

  return {
    defaultScopes,
    retrieval,
    storagePath,
  };
}

function buildRetrievalConfig(input: {
  retrievalBackend?: string;
  embeddingsProvider?: string;
  embeddingsModel?: string;
  embeddingsBaseUrl?: string;
  qmdCommand?: string;
}): MarvMemOptions["retrieval"] | undefined {
  const backend = input.retrievalBackend?.trim();
  const provider = input.embeddingsProvider?.trim();
  const model = input.embeddingsModel?.trim();
  const baseUrl = input.embeddingsBaseUrl?.trim();
  const qmdCommand = input.qmdCommand?.trim();

  if (!backend && !provider && !qmdCommand) {
    return undefined;
  }

  if (backend && backend !== "builtin" && backend !== "qmd") {
    throw new Error(`Unsupported retrieval backend: ${backend}`);
  }

  if (
    provider &&
    provider !== "openai" &&
    provider !== "gemini" &&
    provider !== "voyage" &&
    provider !== "script" &&
    provider !== "auto"
  ) {
    throw new Error(`Unsupported embeddings provider: ${provider}`);
  }

  return {
    backend: (backend ?? (provider ? "builtin" : undefined)) as RetrievalBackend | undefined,
    embeddings: provider
      ? {
          provider: provider as EmbeddingsConfig["provider"],
          model,
          remote: baseUrl
            ? {
                baseUrl,
              }
            : undefined,
        }
      : undefined,
    qmd:
      backend === "qmd" || qmdCommand
        ? {
            enabled: true,
            command: qmdCommand,
          }
        : undefined,
  };
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
