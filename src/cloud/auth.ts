import type { CloudUser, Plan, TeamRole } from "./types.js";

// ---------------------------------------------------------------------------
// CloudAuthProvider
// ---------------------------------------------------------------------------

/**
 * Validates cloud authentication tokens and resolves user identity.
 * Implement for Supabase JWT, custom tokens, or testing.
 */
export interface CloudAuthProvider {
  /** Validate a bearer token and return the user. Returns null if invalid. */
  validateToken(token: string): Promise<CloudUser | null>;

  /** Check if user has access to a project. */
  checkProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<{ allowed: boolean; role?: TeamRole }>;

  /** Get user's plan. */
  getUserPlan(userId: string): Promise<Plan>;
}

// ---------------------------------------------------------------------------
// InMemoryAuthProvider — for testing & local dev
// ---------------------------------------------------------------------------

export class InMemoryAuthProvider implements CloudAuthProvider {
  private users = new Map<string, CloudUser>();
  private tokens = new Map<string, string>(); // token → userId
  private projectRoles = new Map<string, TeamRole>(); // userId:projectId → role

  /** Register a user with a token (for testing). */
  register(token: string, user: CloudUser): void {
    this.users.set(user.id, user);
    this.tokens.set(token, user.id);
  }

  /** Grant project access (for testing). */
  grantAccess(userId: string, projectId: string, role: TeamRole): void {
    this.projectRoles.set(`${userId}:${projectId}`, role);
    const user = this.users.get(userId);
    if (user && !user.projectIds.includes(projectId)) {
      user.projectIds.push(projectId);
    }
  }

  async validateToken(token: string): Promise<CloudUser | null> {
    const userId = this.tokens.get(token);
    if (!userId) return null;
    return this.users.get(userId) ?? null;
  }

  async checkProjectAccess(
    userId: string,
    projectId: string,
  ): Promise<{ allowed: boolean; role?: TeamRole }> {
    const role = this.projectRoles.get(`${userId}:${projectId}`);
    if (!role) return { allowed: false };
    return { allowed: true, role };
  }

  async getUserPlan(userId: string): Promise<Plan> {
    return this.users.get(userId)?.plan ?? "free";
  }
}

// ---------------------------------------------------------------------------
// JWT Helpers (for Supabase integration)
// ---------------------------------------------------------------------------

/**
 * Decode a JWT payload without verification (for extracting claims).
 * In production, use Supabase's built-in token verification.
 */
export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Check if a JWT is expired.
 */
export function isJwtExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return Date.now() / 1000 > payload.exp;
}
