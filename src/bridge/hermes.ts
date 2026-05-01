import { homedir } from "node:os";
import { join } from "node:path";
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
import { readMarkdownEntries, writeMarkdownListFile } from "./markdown.js";
import { resolveContextScopes } from "../platform/context.js";

const DEFAULT_MEMORY_MAX_CHARS = 2_200;
const DEFAULT_USER_MAX_CHARS = 1_375;

type HermesPaths = {
  memoryPath: string;
  userPath: string;
};

const CLASSIFICATION_RULES = [
  { target: "user", matchKinds: ["preference", "identity"], matchTags: ["user"] },
];

export type HermesBridgeOptions = {
  memory: MarvMem;
  files?: Partial<HermesPaths>;
  memoryMaxChars?: number;
  userMaxChars?: number;
};

export class HermesBridgeAdapter implements BridgeAdapter {
  readonly name = "hermes";
  private readonly memory: MarvMem;
  private readonly paths: HermesPaths;
  private readonly memoryMaxChars: number;
  private readonly userMaxChars: number;

  constructor(options: HermesBridgeOptions) {
    this.memory = options.memory;
    this.paths = resolveHermesPaths(options.files);
    this.memoryMaxChars = options.memoryMaxChars ?? DEFAULT_MEMORY_MAX_CHARS;
    this.userMaxChars = options.userMaxChars ?? DEFAULT_USER_MAX_CHARS;
  }

  async detect(input: BridgeContext): Promise<boolean> {
    const memRoot = input.sourceRoot ?? join(homedir(), ".hermes", "memories");
    return existsSync(memRoot);
  }

  async import(input: ExternalImportInput): Promise<ImportResult> {
    const { writeScope } = resolveContextScopes(input.bridge.context);
    const scope = writeScope;
    const errors: string[] = [];
    let imported = 0;

    try {
      const [memoryEntries, userEntries] = await Promise.all([
        readMarkdownEntries(this.paths.memoryPath),
        readMarkdownEntries(this.paths.userPath),
      ]);

      for (const entry of memoryEntries) {
        await this.memory.remember({
          scope,
          kind: "note",
          content: entry,
          summary: entry,
          source: "hermes_bridge_import",
          tags: ["hermes", "memory"],
          metadata: { projectionTarget: "memory" },
        });
        imported++;
      }

      for (const entry of userEntries) {
        await this.memory.remember({
          scope,
          kind: "preference",
          content: entry,
          summary: entry,
          source: "hermes_bridge_import",
          tags: ["hermes", "user"],
          metadata: { projectionTarget: "user" },
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

      await Promise.all([
        writeMarkdownListFile(this.paths.memoryPath, memoryEntries, this.memoryMaxChars),
        writeMarkdownListFile(this.paths.userPath, userEntries, this.userMaxChars),
      ]);

      exported = memoryEntries.length + userEntries.length;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return {
      success: errors.length === 0,
      exported,
      files: [this.paths.memoryPath, this.paths.userPath],
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

function resolveHermesPaths(files?: Partial<HermesPaths>): HermesPaths {
  const memoryRoot = join(homedir(), ".hermes", "memories");
  return {
    memoryPath: files?.memoryPath ?? join(memoryRoot, "MEMORY.md"),
    userPath: files?.userPath ?? join(memoryRoot, "USER.md"),
  };
}
