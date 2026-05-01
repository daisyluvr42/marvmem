import type {
  Plan,
  GateCheckResult,
  GateFeature,
  PlanLimits,
} from "./types.js";
import { PLAN_LIMITS } from "./types.js";
import type { UsageMeter } from "./usage.js";

// ---------------------------------------------------------------------------
// PlanGate
// ---------------------------------------------------------------------------

/**
 * Feature gating by subscription plan.
 *
 * Usage:
 *   const gate = new PlanGate(usageMeter);
 *   const result = await gate.check('proj_xxx', 'free', 'write_memory');
 *   if (!result.allowed) throw new Error(result.reason);
 */
export class PlanGate {
  constructor(private readonly usage: UsageMeter) {}

  /**
   * Check if a feature is allowed for the given project and plan.
   */
  async check(
    projectId: string,
    plan: Plan,
    feature: GateFeature,
    context?: { agentCount?: number; seatCount?: number },
  ): Promise<GateCheckResult> {
    const limits: PlanLimits = PLAN_LIMITS[plan];

    switch (feature) {
      case "write_memory": {
        const quota = await this.usage.checkQuota(
          projectId,
          plan,
          "memoriesWritten",
        );
        if (!quota.allowed) {
          return {
            allowed: false,
            reason: `Write quota exceeded: ${quota.current}/${quota.limit} memories this period. Upgrade to increase limit.`,
            usage: { current: quota.current, limit: quota.limit },
          };
        }
        return { allowed: true };
      }

      case "cloud_sync":
        return limits.syncEnabled
          ? { allowed: true }
          : {
              allowed: false,
              reason: "Cloud sync requires Pro plan or above.",
            };

      case "cloud_embedding":
        return limits.cloudEmbedding
          ? { allowed: true }
          : {
              allowed: false,
              reason:
                "Cloud embedding requires Pro plan or above.",
            };

      case "cloud_console":
        return limits.cloudConsole
          ? { allowed: true }
          : {
              allowed: false,
              reason: "Cloud console requires Pro plan or above.",
            };

      case "multi_agent": {
        const agentCount = context?.agentCount ?? 0;
        if (agentCount >= limits.maxAgents) {
          return {
            allowed: false,
            reason: `Agent limit reached: ${agentCount}/${limits.maxAgents}. Upgrade to add more agents.`,
            usage: { current: agentCount, limit: limits.maxAgents },
          };
        }
        return { allowed: true };
      }

      case "rbac":
        return limits.rbac
          ? { allowed: true }
          : {
              allowed: false,
              reason: "RBAC requires Team plan or above.",
            };

      case "bridge_marketplace":
        return limits.bridgeMarketplace
          ? { allowed: true }
          : {
              allowed: false,
              reason:
                "Bridge marketplace requires Team plan or above.",
            };

      case "team_dashboard": {
        const seatCount = context?.seatCount ?? 0;
        if (!limits.teamDashboard) {
          return {
            allowed: false,
            reason: "Team dashboard requires Team plan or above.",
          };
        }
        if (seatCount >= limits.maxSeats) {
          return {
            allowed: false,
            reason: `Seat limit reached: ${seatCount}/${limits.maxSeats}.`,
            usage: { current: seatCount, limit: limits.maxSeats },
          };
        }
        return { allowed: true };
      }

      default:
        return { allowed: true };
    }
  }

  /**
   * Convenience: assert a feature is allowed, throw if not.
   */
  async assert(
    projectId: string,
    plan: Plan,
    feature: GateFeature,
    context?: { agentCount?: number; seatCount?: number },
  ): Promise<void> {
    const result = await this.check(projectId, plan, feature, context);
    if (!result.allowed) {
      const err = new Error(result.reason) as Error & { code: string };
      err.code = "PLAN_LIMIT_EXCEEDED";
      throw err;
    }
  }

  /**
   * Get all features and their availability for a plan (for UI display).
   */
  getFeatureMatrix(plan: Plan): Record<GateFeature, boolean> {
    const limits = PLAN_LIMITS[plan];
    return {
      write_memory: true, // always available, just quota-limited
      cloud_sync: limits.syncEnabled,
      cloud_embedding: limits.cloudEmbedding,
      cloud_console: limits.cloudConsole,
      multi_agent: limits.maxAgents > 1,
      rbac: limits.rbac,
      bridge_marketplace: limits.bridgeMarketplace,
      team_dashboard: limits.teamDashboard,
    };
  }
}
