#!/usr/bin/env node
/**
 * Dev script to launch MarvMem server with a test project + seeded data.
 * Usage: npx tsx src/bin/dev-server.ts
 */
import { createMarvMem } from "../core/memory.js";
import { MarvMemPlatformService } from "../platform/service.js";
import { InMemoryInspectEventStore } from "../inspect/store.js";
import { ProjectStore } from "../auth/project.js";
import { createMarvMemServer } from "../http/server.js";

async function main() {
  const memory = createMarvMem({ storage: { backend: "memory" } });
  const events = new InMemoryInspectEventStore();
  const platform = new MarvMemPlatformService({ memory, events });
  const projects = new ProjectStore();

  const { apiKey, project } = projects.create("Dev Project");

  // Seed sample memories
  const sampleMemories = [
    { kind: "repo_convention", content: "Use ESM modules with .js extensions in imports", tags: ["esm", "typescript"] },
    { kind: "preference", content: "User prefers dark mode for all interfaces", tags: ["ui"] },
    { kind: "fact", content: "The project uses pnpm as package manager", tags: ["tooling"] },
    { kind: "decision", content: "Adopted SQLite as the default storage backend for zero-dependency local dev", tags: ["arch", "storage"] },
    { kind: "workflow_rule", content: "Always run npm test before committing changes", tags: ["ci"] },
    { kind: "experience", content: "Qdrant vector search significantly outperforms brute-force cosine for >10k records", tags: ["perf", "vector"] },
    { kind: "fact", content: "MarvMem supports both InMemory and SQLite storage backends", tags: ["arch"] },
    { kind: "preference", content: "User prefers concise code comments in Chinese", tags: ["style"] },
    { kind: "repo_convention", content: "All exported functions must have JSDoc comments", tags: ["docs", "conventions"] },
    { kind: "lesson", content: "Entity extractor PascalCase regex can false-positive on common English compound words", tags: ["entity", "bugs"] },
  ];

  for (const mem of sampleMemories) {
    await platform.writeMemory({
      context: { projectId: project.id },
      kind: mem.kind,
      content: mem.content,
      tags: mem.tags,
    });
  }

  const server = createMarvMemServer({
    platform,
    projects,
    events,
    port: 3377,
    consolePath: "src/console",
  });

  await server.listen();

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║        MarvMem Dev Server                ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Console:  http://127.0.0.1:3377/console ║`);
  console.log(`║  API:      http://127.0.0.1:3377/v1/     ║`);
  console.log(`║  API Key:  ${apiKey.slice(0, 20)}...    ║`);
  console.log("╚══════════════════════════════════════════╝\n");
  console.log(`Full API Key: ${apiKey}`);
  console.log(`Project ID:   ${project.id}`);
  console.log(`Seeded ${sampleMemories.length} memories.\n`);
}

main().catch(console.error);
