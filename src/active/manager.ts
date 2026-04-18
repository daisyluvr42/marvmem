import { normalizeScope, type MemoryScope } from "../core/types.js";
import type { MemoryInferencerResult } from "../system/types.js";
import type {
  ActiveMemoryDocument,
  ActiveMemoryKind,
  ActiveMemoryManagerOptions,
} from "./types.js";

const DEFAULT_CONTEXT_MAX_CHARS = 400;
const DEFAULT_EXPERIENCE_MAX_CHARS = 800;

export class ActiveMemoryManager {
  private readonly now: () => Date;
  private readonly contextMaxChars: number;
  private readonly experienceMaxChars: number;

  constructor(private readonly options: ActiveMemoryManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.contextMaxChars = options.contextMaxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
    this.experienceMaxChars = options.experienceMaxChars ?? DEFAULT_EXPERIENCE_MAX_CHARS;
  }

  async read(kind: ActiveMemoryKind, scope: MemoryScope): Promise<ActiveMemoryDocument | null> {
    return await this.options.store.get(kind, normalizeScope(scope));
  }

  async write(input: {
    kind: ActiveMemoryKind;
    scope: MemoryScope;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<ActiveMemoryDocument> {
    return await this.options.store.put({
      kind: input.kind,
      scope: normalizeScope(input.scope),
      content: input.content.trim(),
      metadata: input.metadata,
      updatedAt: this.now().toISOString(),
    });
  }

  async clearContext(scope: MemoryScope): Promise<boolean> {
    return await this.options.store.delete("context", normalizeScope(scope));
  }

  async distillContext(input: {
    scope: MemoryScope;
    sessionSummary: string;
    maxChars?: number;
  }): Promise<ActiveMemoryDocument> {
    const scope = normalizeScope(input.scope);
    const current = await this.read("context", scope);
    const maxChars = input.maxChars ?? this.contextMaxChars;
    const fallback = clampChars(input.sessionSummary.trim(), maxChars);
    const result = await this.infer({
      kind: "context",
      system:
        "Summarize the working context into a concise active-memory note. " +
        "Keep current task state, decisions, pending items, and blockers.",
      prompt: input.sessionSummary,
      maxChars,
    });
    return await this.write({
      kind: "context",
      scope,
      content: result.ok ? clampChars(result.text, maxChars) : fallback,
      metadata: current?.metadata,
    });
  }

  async distillExperience(input: {
    scope: MemoryScope;
    newData: string;
    maxChars?: number;
  }): Promise<ActiveMemoryDocument> {
    const scope = normalizeScope(input.scope);
    const current = await this.read("experience", scope);
    const maxChars = input.maxChars ?? this.experienceMaxChars;
    const fallback = clampChars(
      [current?.content.trim(), input.newData.trim()].filter(Boolean).join("\n\n"),
      maxChars,
    );
    const result = await this.infer({
      kind: "experience",
      system:
        "Maintain a concise reusable experience document. Keep durable lessons, strategies, and behavior guidance. " +
        "Do not keep raw conversational detail.",
      prompt: buildExperiencePrompt(current?.content, input.newData),
      currentContent: current?.content,
      maxChars,
    });
    return await this.write({
      kind: "experience",
      scope,
      content: result.ok ? clampChars(result.text, maxChars) : fallback,
      metadata: current?.metadata,
    });
  }

  async formatRecall(scope: MemoryScope): Promise<string> {
    const context = await this.read("context", scope);
    const experience = await this.read("experience", scope);
    const blocks = [
      context?.content.trim()
        ? `Active context:\n${context.content.trim()}`
        : "",
      experience?.content.trim()
        ? `Active experience:\n${experience.content.trim()}`
        : "",
    ].filter(Boolean);
    return blocks.join("\n\n");
  }

  private async infer(input: {
    kind: "context" | "experience";
    system: string;
    prompt: string;
    maxChars: number;
    currentContent?: string;
  }): Promise<MemoryInferencerResult> {
    if (!this.options.inferencer) {
      return { ok: false, error: "No inferencer configured" };
    }
    return await this.options.inferencer({
      kind: input.kind,
      system: input.system,
      prompt: input.prompt,
      maxChars: input.maxChars,
      currentContent: input.currentContent,
    });
  }
}

function buildExperiencePrompt(currentContent: string | undefined, newData: string): string {
  return [
    "## Current experience",
    currentContent?.trim() || "(empty)",
    "",
    "## New data",
    newData.trim(),
  ].join("\n");
}

function clampChars(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars).trimEnd();
}
