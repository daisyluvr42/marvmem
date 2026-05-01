// ---------------------------------------------------------------------------
// Cloud Infrastructure — Types
// ---------------------------------------------------------------------------

/**
 * Subscription plan tiers.
 */
export type Plan = "free" | "pro" | "team" | "enterprise";

/**
 * Plan limits definition.
 */
export type PlanLimits = {
  /** Max memories written per billing period */
  memoriesPerPeriod: number;
  /** Max total stored memories */
  memoriesTotal: number;
  /** Max distinct agent IDs per project */
  maxAgents: number;
  /** Max team members (for team/enterprise) */
  maxSeats: number;
  /** Cloud sync enabled */
  syncEnabled: boolean;
  /** Cloud embedding enabled */
  cloudEmbedding: boolean;
  /** Cloud console enabled */
  cloudConsole: boolean;
  /** RBAC enabled */
  rbac: boolean;
  /** Bridge marketplace */
  bridgeMarketplace: boolean;
  /** Team dashboard */
  teamDashboard: boolean;
};

/**
 * Canonical plan limits.
 */
export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    memoriesPerPeriod: 500,
    memoriesTotal: 2_000,
    maxAgents: 1,
    maxSeats: 1,
    syncEnabled: false,
    cloudEmbedding: false,
    cloudConsole: false,
    rbac: false,
    bridgeMarketplace: false,
    teamDashboard: false,
  },
  pro: {
    memoriesPerPeriod: 5_000,
    memoriesTotal: 50_000,
    maxAgents: 10,
    maxSeats: 1,
    syncEnabled: true,
    cloudEmbedding: true,
    cloudConsole: true,
    rbac: false,
    bridgeMarketplace: false,
    teamDashboard: false,
  },
  team: {
    memoriesPerPeriod: 50_000,
    memoriesTotal: 500_000,
    maxAgents: 50,
    maxSeats: 50,
    syncEnabled: true,
    cloudEmbedding: true,
    cloudConsole: true,
    rbac: true,
    bridgeMarketplace: true,
    teamDashboard: true,
  },
  enterprise: {
    memoriesPerPeriod: Infinity,
    memoriesTotal: Infinity,
    maxAgents: Infinity,
    maxSeats: Infinity,
    syncEnabled: true,
    cloudEmbedding: true,
    cloudConsole: true,
    rbac: true,
    bridgeMarketplace: true,
    teamDashboard: true,
  },
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Billing period key, e.g. "2026-04" */
export type BillingPeriod = string;

export type UsageRecord = {
  projectId: string;
  period: BillingPeriod;
  memoriesWritten: number;
  memoriesTotal: number;
  embeddingsCount: number;
  syncOperations: number;
  updatedAt: string;
};

export type UsageCounter =
  | "memoriesWritten"
  | "memoriesTotal"
  | "embeddingsCount"
  | "syncOperations";

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export type SyncState = {
  projectId: string;
  lastSyncVersion: number;
  lastSyncAt: string | null;
  pendingPushCount: number;
};

export type SyncDirection = "push" | "pull";

export type SyncResult = {
  direction: SyncDirection;
  recordsProcessed: number;
  newSyncVersion: number;
  errors: string[];
};

/**
 * A memory record augmented with sync metadata.
 */
export type CloudMemoryRecord = {
  id: string;
  projectId: string;
  scopeType: string;
  scopeId: string;
  kind: string;
  content: string;
  summary?: string;
  confidence: number;
  importance: number;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  syncVersion: number;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type CloudUser = {
  id: string;
  email: string;
  plan: Plan;
  projectIds: string[];
};

/** Role within a team project */
export type TeamRole = "owner" | "admin" | "editor" | "viewer";

export type TeamMember = {
  userId: string;
  email: string;
  role: TeamRole;
  joinedAt: string;
};

// ---------------------------------------------------------------------------
// Cloud Config
// ---------------------------------------------------------------------------

export type CloudConfig = {
  enabled: boolean;
  /** Supabase project URL */
  supabaseUrl?: string;
  /** Supabase anon/service key */
  supabaseKey?: string;
  /** Custom API endpoint (if self-hosted) */
  apiUrl?: string;
};

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type GateCheckResult = {
  allowed: boolean;
  reason?: string;
  /** Current usage vs limit */
  usage?: { current: number; limit: number };
};

export type GateFeature =
  | "write_memory"
  | "cloud_sync"
  | "cloud_embedding"
  | "cloud_console"
  | "multi_agent"
  | "rbac"
  | "bridge_marketplace"
  | "team_dashboard";
