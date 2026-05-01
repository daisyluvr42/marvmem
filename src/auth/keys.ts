import { randomUUID, createHash } from "node:crypto";
import type { ApiKeyInfo, Project } from "./types.js";

const KEY_PREFIX = "mm_";

/**
 * Generate a new API key with mm_ prefix.
 */
export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

/**
 * Hash an API key for storage. Never store the raw key.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Extract the visible prefix from an API key (first 12 chars).
 */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, 12);
}

/**
 * Validate that a string looks like a valid API key.
 */
export function isValidApiKeyFormat(key: string): boolean {
  return key.startsWith(KEY_PREFIX) && key.length >= 20;
}
