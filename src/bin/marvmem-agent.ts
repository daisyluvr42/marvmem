#!/usr/bin/env node

import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  AGENT_IDS,
  defaultAgentMcpPath,
  getAgentStatuses,
  importSessions,
  installAgent,
  isAgentId,
  parseAgentTarget,
  resolveAgentOptions,
  type AgentId,
  type AgentInstallOptions,
} from "../agents/manager.js";
import { createMarvMem } from "../core/index.js";
import { createMarvMemServer } from "../http/server.js";
import { InMemoryInspectEventStore } from "../inspect/store.js";
import { defaultMemoryMcpStoragePath } from "../mcp/stdio.js";
import { MarvMemPlatformService } from "../platform/service.js";
import { ProjectStore } from "../auth/project.js";

const HELP = `marvmem-agent

Install MarvMem globally for coding agents, or launch the local setup UI.

Usage:
  marvmem-agent install <codex|claude|cursor|copilot|antigravity|all>
  marvmem-agent ui
  marvmem-agent tui

Options:
  --storage-path <path>  Shared SQLite database path (default: ${defaultMemoryMcpStoragePath()})
  --mcp-path <path>      marvmem-mcp script path (default: sibling dist/bin/marvmem-mcp.js)
  --sessions-root <path> Override session root for a single agent import
  --home <path>          Home directory for agent config paths (default: current user home)
  --skip-mcp             Do not install MCP configuration
  --skip-import          Do not import existing sessions
  --skip-instructions    Do not update agent instruction files
  --once                 Print TUI status once and exit (tui only)
  --port <number>        UI server port (ui only, default: 3377)
  --host <host>          UI server host (ui only, default: 127.0.0.1)
  --help                 Show this message
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (argv[0] === "install") {
    const { agents, options } = parseInstallArgs(argv.slice(1));
    const results = [];
    for (const agent of agents) {
      results.push(await installAgent(agent, options));
    }
    process.stdout.write(`${JSON.stringify({ storagePath: options.storagePath, results }, null, 2)}\n`);
    return;
  }

  if (argv[0] === "ui") {
    await runUi(parseUiArgs(argv.slice(1)));
    return;
  }

  if (argv[0] === "tui") {
    await runTui(parseTuiArgs(argv.slice(1)));
    return;
  }

  throw new Error("Expected command: install, ui, or tui");
}

function parseInstallArgs(argv: string[]) {
  const target = argv[0];
  if (!target) {
    throw new Error("Missing agent target");
  }

  const agents = parseAgentTarget(target);
  const options = resolveAgentOptions(parseSharedAgentOptions(argv, 1));
  if (options.sessionsRoot && agents.length !== 1) {
    throw new Error("--sessions-root can only be used with a single agent");
  }
  return { agents, options };
}

function parseUiArgs(argv: string[]) {
  let port = 3377;
  let host = "127.0.0.1";
  const agentOptions: AgentInstallOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") {
      port = Number.parseInt(readFlagValue(argv, ++index, arg), 10);
      continue;
    }
    if (arg === "--host") {
      host = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--storage-path") {
      agentOptions.storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mcp-path") {
      agentOptions.mcpPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      agentOptions.home = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("Invalid --port value");
  }

  return { port, host, options: resolveAgentOptions(agentOptions) };
}

function parseTuiArgs(argv: string[]) {
  let once = false;
  const agentOptions: AgentInstallOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg === "--storage-path") {
      agentOptions.storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mcp-path") {
      agentOptions.mcpPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      agentOptions.home = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { once, options: resolveAgentOptions(agentOptions) };
}

function parseSharedAgentOptions(
  argv: string[],
  startIndex: number,
): AgentInstallOptions {
  const options: AgentInstallOptions = {};

  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--storage-path") {
      options.storagePath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mcp-path") {
      options.mcpPath = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--sessions-root") {
      options.sessionsRoot = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--home") {
      options.home = readFlagValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--skip-mcp") {
      options.skipMcp = true;
      continue;
    }
    if (arg === "--skip-import") {
      options.skipImport = true;
      continue;
    }
    if (arg === "--skip-instructions") {
      options.skipInstructions = true;
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function runUi(input: {
  port: number;
  host: string;
  options: ReturnType<typeof resolveAgentOptions>;
}): Promise<void> {
  const memory = createMarvMem({
    storage: {
      backend: "sqlite",
      path: input.options.storagePath,
    },
  });
  const events = new InMemoryInspectEventStore();
  const platform = new MarvMemPlatformService({ memory, events });
  const projects = new ProjectStore();
  const { apiKey, project } = projects.create("Local MarvMem");
  const server = createMarvMemServer({
    platform,
    projects,
    events,
    port: input.port,
    host: input.host,
    consolePath: defaultConsolePath(),
    agents: {
      home: input.options.home,
      storagePath: input.options.storagePath,
      mcpPath: input.options.mcpPath,
    },
  });

  await server.listen();

  process.stdout.write(
    [
      "MarvMem agent setup UI",
      `Console: ${server.address}/console#agents`,
      `API Key: ${apiKey}`,
      `Project ID: ${project.id}`,
      `Storage: ${input.options.storagePath}`,
      `MCP Path: ${input.options.mcpPath || defaultAgentMcpPath()}`,
      "",
    ].join("\n"),
  );
}

async function runTui(input: {
  once: boolean;
  options: ReturnType<typeof resolveAgentOptions>;
}): Promise<void> {
  if (input.once) {
    process.stdout.write(await renderTuiStatus(input.options));
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1b[2J\x1b[H");
      }
      process.stdout.write(await renderTuiStatus(input.options));
      process.stdout.write("\nActions\n");
      process.stdout.write("  1) Install all\n");
      process.stdout.write("  2) Import all\n");
      process.stdout.write("  3) Install agent\n");
      process.stdout.write("  4) Import agent\n");
      process.stdout.write("  r) Refresh\n");
      process.stdout.write("  q) Quit\n\n");

      const choice = (await rl.question("Select action: ")).trim().toLowerCase();
      if (choice === "q" || choice === "quit") {
        break;
      }
      if (choice === "r" || choice === "refresh" || choice === "") {
        continue;
      }

      try {
        if (choice === "1") {
          for (const agent of AGENT_IDS) {
            await installAgent(agent, input.options);
          }
          await pause(rl, "Installed all agents.");
          continue;
        }
        if (choice === "2") {
          for (const agent of AGENT_IDS) {
            await importSessions(agent, input.options);
          }
          await pause(rl, "Imported all agents.");
          continue;
        }
        if (choice === "3") {
          const agent = await askAgent(rl);
          if (agent) {
            await installAgent(agent, input.options);
            await pause(rl, `Installed ${agent}.`);
          }
          continue;
        }
        if (choice === "4") {
          const agent = await askAgent(rl);
          if (agent) {
            await importSessions(agent, input.options);
            await pause(rl, `Imported ${agent}.`);
          }
          continue;
        }
        await pause(rl, `Unknown action: ${choice}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await pause(rl, `Operation failed: ${message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function renderTuiStatus(options: ReturnType<typeof resolveAgentOptions>): Promise<string> {
  const statuses = await getAgentStatuses(options);
  const rows = statuses.map((status, index) => [
    String(index + 1),
    status.label,
    status.mcp.configured && status.mcp.storagePathMatches ? "ready" : status.mcp.configured ? "wrong-db" : "missing",
    status.instructions.supported ? (status.instructions.installed ? "installed" : "missing") : "n/a",
    status.sessions.rootExists ? "found" : "missing",
    `${status.imported.memories}/${status.imported.tasks}`,
  ]);

  return [
    "MarvMem Agent TUI",
    `Storage: ${options.storagePath}`,
    `MCP:     ${options.mcpPath}`,
    "",
    formatTable([
      ["#", "Agent", "MCP", "Instructions", "Sessions", "Imported M/T"],
      ...rows,
    ]),
    "",
  ].join("\n");
}

function formatTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows
    .map((row, index) => {
      const line = row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
      return index === 0 ? `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}` : line;
    })
    .join("\n");
}

async function askAgent(rl: ReturnType<typeof createInterface>): Promise<AgentId | null> {
  process.stdout.write("\nAgents\n");
  AGENT_IDS.forEach((agent, index) => {
    process.stdout.write(`  ${index + 1}) ${agent}\n`);
  });
  const answer = (await rl.question("\nSelect agent: ")).trim().toLowerCase();
  const byIndex = Number.parseInt(answer, 10);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= AGENT_IDS.length) {
    return AGENT_IDS[byIndex - 1]!;
  }
  return isAgentId(answer) ? answer : null;
}

async function pause(rl: ReturnType<typeof createInterface>, message: string): Promise<void> {
  await rl.question(`\n${message}\nPress Enter to continue.`);
}

function defaultConsolePath(): string {
  const current = fileURLToPath(import.meta.url);
  return join(dirname(dirname(current)), "console");
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
