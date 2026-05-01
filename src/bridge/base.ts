import type { MemoryRecord } from "../core/types.js";
import type { MemoryContext } from "../platform/types.js";

// ---------------------------------------------------------------------------
// Bridge context
// ---------------------------------------------------------------------------

/**
 * Context for bridge operations.
 * `sourceRoot` is the filesystem root for the external agent workspace.
 * Only meaningful in local/self-hosted mode.
 */
export type BridgeContext = {
  context: MemoryContext;
  sourceRoot?: string;
};

// ---------------------------------------------------------------------------
// Bridge operation results
// ---------------------------------------------------------------------------

export type ImportedEntry = {
  content: string;
  kind: string;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
};

export type ImportResult = {
  success: boolean;
  imported: number;
  entries: ImportedEntry[];
  errors?: string[];
};

export type ExportResult = {
  success: boolean;
  exported: number;
  files?: string[];
  errors?: string[];
};

export type ProjectionSyncResult = {
  success: boolean;
  direction: "import" | "export";
  imported?: number;
  exported?: number;
  errors?: string[];
};

// ---------------------------------------------------------------------------
// Bridge inputs
// ---------------------------------------------------------------------------

export type ExternalImportInput = {
  bridge: BridgeContext;
};

export type ExternalExportInput = {
  bridge: BridgeContext;
};

export type ProjectionSyncInput = {
  bridge: BridgeContext;
  direction: "import" | "export";
};

// ---------------------------------------------------------------------------
// Bridge adapter interface
// ---------------------------------------------------------------------------

/**
 * A BridgeAdapter connects an external agent runtime's memory artifacts
 * (markdown files, config files, etc.) with MarvMem's shared backend.
 *
 * MVP supports directional import and export only.
 * Bidirectional sync is deferred until conflict resolution policy is defined.
 */
export interface BridgeAdapter {
  /** Adapter name, e.g. "openclaw" or "hermes" */
  readonly name: string;

  /**
   * Detect whether the external agent workspace exists at the given
   * sourceRoot. Returns true if the adapter can operate.
   */
  detect(input: BridgeContext): Promise<boolean>;

  /**
   * Import external memory artifacts into MarvMem.
   * Records are written via the platform service using the bridge context.
   */
  import(input: ExternalImportInput): Promise<ImportResult>;

  /**
   * Export MarvMem records back to external memory artifact files.
   * Only applicable in local/self-hosted mode.
   */
  export(input: ExternalExportInput): Promise<ExportResult>;

  /**
   * Directional sync: shorthand for import-then-export or export-only.
   * Bidirectional sync is NOT supported in MVP.
   */
  sync(input: ProjectionSyncInput): Promise<ProjectionSyncResult>;
}

// ---------------------------------------------------------------------------
// Bridge registry
// ---------------------------------------------------------------------------

export type BridgeRegistry = Map<string, BridgeAdapter>;

export function createBridgeRegistry(adapters: BridgeAdapter[]): BridgeRegistry {
  const registry: BridgeRegistry = new Map();
  for (const adapter of adapters) {
    registry.set(adapter.name, adapter);
  }
  return registry;
}
