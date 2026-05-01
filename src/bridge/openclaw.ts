import { homedir } from "node:os";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import type { MarvMem } from "../core/memory.js";
import type { MemoryScope } from "../core/types.js";
import type {
  BridgeAdapter,
  BridgeContext,
  ExternalExportInput,
  ExternalImportInput,
  ExportResult,
  ImportResult,
  ProjectionSyncInput,
  ProjectionSyncResult,
} from "./base.js";
import { classifyRecord, summarizeRecordForProjection } from "./policy.js";
import {
  listMarkdownFiles,
  parseMarkdownEntries,
  readTextFile,
  writeMarkdownBlocksFile,
  writeMarkdownListFile,
} from "./markdown.js";
import { resolveContextScopes } from "../platform/context.js";

const DEFAULT_MEMORY_MAX_CHARS = 2_200;
const DEFAULT_USER_MAX_CHARS = 1_375;

type OpenClawPaths = {
  workspacePath: string;
  memoryPath: string;
  userPath: string;
  dreamsPath: string;
  dailyDir: string;
};

const CLASSIFICATION_RULES = [
  { target: "user", matchKinds: ["preference", "identity"], matchTags: ["user"] },
  { target: "daily", matchKinds: ["openclaw_daily"], matchTags: ["daily"] },
  { target: "dreams", matchKinds: ["experience"], matchTags: ["dreams"] },
];

export type OpenClawBridgeOptions = {
  memory: MarvMem;
  files?: Partial<OpenClawPaths>;
  memoryMaxChars?: number;
  userMaxChars?: number;
};

export class OpenClawBridgeAdapter implements BridgeAdapter {
  readonly name = "openclaw";
  private readonly memory: MarvMem;
  private readonly paths: OpenClawPaths;
  private readonly memoryMaxChars: number;
  private readonly userMaxChars: number;

  constructor(options: OpenClawBridgeOptions) {
    this.memory = options.memory;
    this.paths = resolveOpenClawPaths(options.files);
    this.memoryMaxChars = options.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS;
    this.userMaxChars = options.userMaxChars ?? DEFAULT_USER_MAX_CHARS;
  }

  async detect(input: BridgeContext): Promise<boolean> {
    const root = input.sourceRoot ?? this.paths.workspacePath;
    return existsSync(root);
  }

  async import(input: ExternalImportInput): Promise<ImportResult> {
    const { writeScope } = resolveContextScopes(input.bridge.context);
    const scope = writeScope;
    const errors: string[] = [];
    let imported = 0;

    try {
      // MEMORY.md
      const memoryEntries = parseMarkdownEntries((await readTextFile(this.paths.memoryPath)) ?? "");
      for (const entry of memoryEntries) {
        await this.memory.remember({
          scope,
          kind: "note",
          content: entry,
          summary: entry,
          source: "openclaw_bridge_import",
          tags: ["openclaw", "memory"],
          metadata: { projectionTarget: "memory" },
        });
        imported++;
      }

      // USER.md
      const userEntries = parseMarkdownEntries((await readTextFile(this.paths.userPath)) ?? "");
      for (const entry of userEntries) {
        await this.memory.remember({
          scope,
          kind: "preference",
          content: entry,
          summary: entry,
          source: "openclaw_bridge_import",
          tags: ["openclaw", "user"],
          metadata: { projectionTarget: "user" },
        });
        imported++;
      }

      // Daily files
      for (const file of await listMarkdownFiles(this.paths.dailyDir)) {
        const day = basename(file, ".md");
        const blocks = parseMarkdownEntries((await readTextFile(file)) ?? "");
        for (const block of blocks) {
          await this.memory.remember({
            scope,
            kind: "openclaw_daily",
            content: block,
            summary: block.length <= 120 ? block : `${block.slice(0, 117)}...`,
            source: "openclaw_bridge_import",
            tags: ["openclaw", "daily"],
            metadata: { projectionTarget: "daily", day },
          });
          imported++;
        }
      }

      // DREAMS.md
      const dreamEntries = parseMarkdownEntries((await readTextFile(this.paths.dreamsPath)) ?? "");
      for (const entry of dreamEntries) {
        await this.memory.remember({
          scope,
          kind: "experience",
          content: entry,
          summary: entry,
          source: "openclaw_bridge_import",
          tags: ["openclaw", "dreams"],
          metadata: { projectionTarget: "dreams" },
        });
        imported++;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
      success: errors.length === 0,
      imported,
      entries: [],
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async export(input: ExternalExportInput): Promise<ExportResult> {
    const { recallScopes } = resolveContextScopes(input.bridge.context);
    const errors: string[] = [];
    let exported = 0;

    try {
      const records = await this.memory.list({ scopes: recallScopes });

      const memoryEntries = records
        .filter((r) => classifyRecord(r, CLASSIFICATION_RULES) === "memory")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summarizeRecordForProjection);

      const userEntries = records
        .filter((r) => classifyRecord(r, CLASSIFICATION_RULES) === "user")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summarizeRecordForProjection);

      const dreamsEntries = records
        .filter((r) => classifyRecord(r, CLASSIFICATION_RULES) === "dreams")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summarizeRecordForProjection);

      await writeMarkdownListFile(this.paths.memoryPath, memoryEntries, this.memoryMaxChars);
      exported += memoryEntries.length;

      await writeMarkdownListFile(this.paths.userPath, userEntries, this.userMaxChars);
      exported += userEntries.length;

      if (dreamsEntries.length > 0 || (await readTextFile(this.paths.dreamsPath)) !== null) {
        await writeMarkdownListFile(this.paths.dreamsPath, dreamsEntries);
        exported += dreamsEntries.length;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
      success: errors.length === 0,
      exported,
      files: [this.paths.memoryPath, this.paths.userPath, this.paths.dreamsPath],
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async sync(input: ProjectionSyncInput): Promise<ProjectionSyncResult> {
    const errors: string[] = [];
    let imported = 0;
    let exported = 0;

    if (input.direction === "import") {
      const result = await this.import({ bridge: input.bridge });
      imported = result.imported;
      if (result.errors) errors.push(...result.errors);
    } else if (input.direction === "export") {
      const result = await this.export({ bridge: input.bridge });
      exported = result.exported;
      if (result.errors) errors.push(...result.errors);
    }

    return {
      success: errors.length === 0,
      direction: input.direction,
      imported: imported > 0 ? imported : undefined,
      exported: exported > 0 ? exported : undefined,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

function resolveOpenClawPaths(files?: Partial<OpenClawPaths>): OpenClawPaths {
  const workspacePath = files?.workspacePath ?? join(homedir(), ".openclaw", "workspace");
  return {
    workspacePath,
    memoryPath: files?.memoryPath ?? join(workspacePath, "MEMORY.md"),
    userPath: files?.userPath ?? join(workspacePath, "USER.md"),
    dreamsPath: files?.dreamsPath ?? join(workspacePath, "DREAMS.md"),
    dailyDir: files?.dailyDir ?? join(workspacePath, "memory"),
  };
}
