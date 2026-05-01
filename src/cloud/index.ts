// ---------------------------------------------------------------------------
// Cloud Infrastructure — Barrel Export
// ---------------------------------------------------------------------------

export type {
  Plan,
  PlanLimits,
  BillingPeriod,
  UsageRecord,
  UsageCounter,
  SyncState,
  SyncResult,
  SyncDirection,
  CloudMemoryRecord,
  CloudUser,
  TeamRole,
  TeamMember,
  CloudConfig,
  GateCheckResult,
  GateFeature,
} from "./types.js";

export { PLAN_LIMITS } from "./types.js";

export type { UsageMeter } from "./usage.js";
export { InMemoryUsageMeter, currentBillingPeriod } from "./usage.js";

export { PlanGate } from "./gate.js";

export type { SyncTarget, LocalSyncStore } from "./sync.js";
export {
  CloudSyncManager,
  InMemorySyncTarget,
  InMemoryLocalSyncStore,
  MemoryStoreLocalSyncStore,
} from "./sync.js";

export type { EmbeddingProvider, CloudEmbeddingConfig } from "./embedding.js";
export {
  CloudEmbeddingProvider,
  FallbackEmbeddingProvider,
} from "./embedding.js";

export type { CloudAuthProvider } from "./auth.js";
export {
  InMemoryAuthProvider,
  decodeJwtPayload,
  isJwtExpired,
} from "./auth.js";
