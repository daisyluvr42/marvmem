import type { MemoryRecord } from "../core/types.js";

// ---------------------------------------------------------------------------
// Projection policy
// ---------------------------------------------------------------------------

/**
 * Defines how a bridge adapter maps between external memory artifacts
 * and MarvMem records.
 */
export type ProjectionPolicy = {
  /** Which external files to import */
  importable: ProjectionFileRule[];

  /** Which memory kinds can be exported back out */
  exportableKinds: string[];

  /** Default source label for imported records */
  importSource: string;

  /** Whether MarvMem is treated as source of truth after import */
  marvmemAuthoritative: boolean;
};

export type ProjectionFileRule = {
  /** File path relative to workspace root */
  relativePath: string;

  /** Memory kind to assign imported entries */
  kind: string;

  /** Tags to add to imported records */
  tags: string[];

  /** Metadata to attach to imported records */
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

export type ProjectionTarget = string;

/**
 * Read the projectionTarget from a record's metadata, if present.
 */
export function readProjectionTarget(record: MemoryRecord): ProjectionTarget | undefined {
  if (
    record.metadata &&
    typeof record.metadata === "object" &&
    typeof record.metadata.projectionTarget === "string"
  ) {
    return record.metadata.projectionTarget;
  }
  return undefined;
}

/**
 * Classify a record into a projection target based on metadata, kind,
 * and tags.  Falls back to the provided default if no match.
 */
export function classifyRecord(
  record: MemoryRecord,
  rules: Array<{
    target: ProjectionTarget;
    matchKinds?: string[];
    matchTags?: string[];
  }>,
  defaultTarget: ProjectionTarget = "memory",
): ProjectionTarget {
  // Prefer explicit metadata target
  const metaTarget = readProjectionTarget(record);
  if (metaTarget) {
    const ruleTargets = rules.map((r) => r.target);
    if (ruleTargets.includes(metaTarget)) {
      return metaTarget;
    }
  }

  // Match by kind or tags
  for (const rule of rules) {
    if (rule.matchKinds && rule.matchKinds.includes(record.kind)) {
      return rule.target;
    }
    if (rule.matchTags && rule.matchTags.some((tag) => record.tags.includes(tag))) {
      return rule.target;
    }
  }

  return defaultTarget;
}

/**
 * Summarize a record for markdown projection.
 */
export function summarizeRecordForProjection(record: MemoryRecord): string {
  return record.summary?.trim() || record.content.trim();
}
