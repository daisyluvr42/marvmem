import { randomUUID } from "node:crypto";
import type { Project } from "./types.js";
import { generateApiKey, hashApiKey, apiKeyPrefix } from "./keys.js";

// ---------------------------------------------------------------------------
// In-memory project store (MVP)
// ---------------------------------------------------------------------------

export class ProjectStore {
  private readonly projects = new Map<string, Project>();
  private readonly keyIndex = new Map<string, string>(); // hash → projectId

  register(project: Project): void {
    this.projects.set(project.id, project);
    this.keyIndex.set(project.apiKeyHash, project.id);
  }

  /**
   * Create a new project. Returns the project and the raw API key
   * (which must be shown to the user once, then never stored in plaintext).
   */
  create(name: string): { project: Project; apiKey: string } {
    const id = `proj_${randomUUID().slice(0, 8)}`;
    const apiKey = generateApiKey();
    const hash = hashApiKey(apiKey);

    const project: Project = {
      id,
      name,
      apiKeyHash: hash,
      createdAt: new Date().toISOString(),
    };

    this.projects.set(id, project);
    this.keyIndex.set(hash, id);

    return { project, apiKey };
  }

  /**
   * Resolve a raw API key to a project. Returns null if invalid.
   */
  resolveKey(apiKey: string): Project | null {
    const hash = hashApiKey(apiKey);
    const projectId = this.keyIndex.get(hash);
    if (!projectId) return null;
    return this.projects.get(projectId) ?? null;
  }

  /**
   * Get a project by ID.
   */
  get(id: string): Project | null {
    return this.projects.get(id) ?? null;
  }

  /**
   * Rotate API key for a project. Returns the new raw key.
   */
  rotateKey(projectId: string): string | null {
    const project = this.projects.get(projectId);
    if (!project) return null;

    // Remove old key index
    this.keyIndex.delete(project.apiKeyHash);

    // Generate new key
    const newKey = generateApiKey();
    const newHash = hashApiKey(newKey);

    project.apiKeyHash = newHash;
    this.keyIndex.set(newHash, projectId);

    return newKey;
  }
}
