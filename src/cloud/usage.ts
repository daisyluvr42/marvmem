import type {
  UsageRecord,
  UsageCounter,
  BillingPeriod,
  Plan,
  PlanLimits,
} from "./types.js";
import { PLAN_LIMITS } from "./types.js";

// ---------------------------------------------------------------------------
// UsageMeter Interface
// ---------------------------------------------------------------------------

/**
 * Tracks resource consumption per project per billing period.
 * All implementations must be safe for concurrent increments.
 */
export interface UsageMeter {
  /** Get usage for a project in the current period. */
  getUsage(projectId: string, period?: BillingPeriod): Promise<UsageRecord>;

  /** Increment a usage counter. Returns the updated record. */
  increment(
    projectId: string,
    counter: UsageCounter,
    amount?: number,
  ): Promise<UsageRecord>;

  /** Check if a write is allowed under the project's plan. */
  checkQuota(
    projectId: string,
    plan: Plan,
    counter: UsageCounter,
  ): Promise<{ allowed: boolean; current: number; limit: number }>;

  /** Reset counters for a new period (for testing or manual rollover). */
  resetPeriod(projectId: string, period: BillingPeriod): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function currentBillingPeriod(): BillingPeriod {
  return new Date().toISOString().slice(0, 7); // "2026-04"
}

function emptyUsage(projectId: string, period: BillingPeriod): UsageRecord {
  return {
    projectId,
    period,
    memoriesWritten: 0,
    memoriesTotal: 0,
    embeddingsCount: 0,
    syncOperations: 0,
    updatedAt: new Date().toISOString(),
  };
}

function getLimit(plan: Plan, counter: UsageCounter): number {
  const limits: PlanLimits = PLAN_LIMITS[plan];
  switch (counter) {
    case "memoriesWritten":
      return limits.memoriesPerPeriod;
    case "memoriesTotal":
      return limits.memoriesTotal;
    case "embeddingsCount":
      return limits.memoriesPerPeriod * 2; // 2x memories
    case "syncOperations":
      return limits.syncEnabled ? Infinity : 0;
    default:
      return Infinity;
  }
}

// ---------------------------------------------------------------------------
// InMemoryUsageMeter
// ---------------------------------------------------------------------------

/**
 * In-memory implementation for local dev and testing.
 * Data does not persist across restarts.
 */
export class InMemoryUsageMeter implements UsageMeter {
  private readonly store = new Map<string, UsageRecord>();

  private key(projectId: string, period: BillingPeriod): string {
    return `${projectId}:${period}`;
  }

  async getUsage(
    projectId: string,
    period?: BillingPeriod,
  ): Promise<UsageRecord> {
    const p = period ?? currentBillingPeriod();
    return this.store.get(this.key(projectId, p)) ?? emptyUsage(projectId, p);
  }

  async increment(
    projectId: string,
    counter: UsageCounter,
    amount = 1,
  ): Promise<UsageRecord> {
    const period = currentBillingPeriod();
    const k = this.key(projectId, period);
    const record = this.store.get(k) ?? emptyUsage(projectId, period);
    record[counter] += amount;
    record.updatedAt = new Date().toISOString();
    this.store.set(k, record);
    return { ...record };
  }

  async checkQuota(
    projectId: string,
    plan: Plan,
    counter: UsageCounter,
  ): Promise<{ allowed: boolean; current: number; limit: number }> {
    const usage = await this.getUsage(projectId);
    const current = usage[counter];
    const limit = getLimit(plan, counter);
    return { allowed: current < limit, current, limit };
  }

  async resetPeriod(
    projectId: string,
    period: BillingPeriod,
  ): Promise<void> {
    this.store.delete(this.key(projectId, period));
  }
}
