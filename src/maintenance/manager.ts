import type { ActiveMemoryDocument } from "../active/types.js";
import type { MemoryScope } from "../core/types.js";
import type { MemoryInferencerResult } from "../system/types.js";
import type {
  ExperienceAttributionResult,
  ExperienceCalibrationResult,
  ExperienceEntryStat,
  ExperienceRebuildResult,
  MaintenanceManagerOptions,
} from "./types.js";

type ExperienceMetadata = {
  entryStats?: ExperienceEntryStat[];
  lastCalibrationAt?: string;
  lastRebuildAt?: string;
};

export class MaintenanceManager {
  private readonly now: () => Date;

  constructor(private readonly options: MaintenanceManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async attributeExperience(input: {
    scope: MemoryScope;
    response: string;
    outcome?: "positive" | "neutral" | "negative";
  }): Promise<ExperienceAttributionResult> {
    const document = await this.options.active.read("experience", input.scope);
    const outcome = input.outcome ?? "neutral";
    if (!document?.content.trim()) {
      return { activatedEntries: [], outcome };
    }
    const entries = parseExperienceEntries(document.content);
    if (entries.length === 0) {
      return { activatedEntries: [], outcome };
    }
    const selected = await this.selectActivatedEntries(entries, input.response);
    const metadata = readExperienceMetadata(document);
    const stats = mergeEntryStats(entries, metadata.entryStats ?? [], this.now().toISOString());
    for (const entry of selected) {
      const stat = stats.find((candidate) => candidate.id === entry.id);
      if (!stat) {
        continue;
      }
      stat.activationCount += 1;
      if (outcome === "positive") {
        stat.positiveCount += 1;
      }
      stat.lastActivatedAt = this.now().toISOString();
    }
    await this.options.active.write({
      kind: "experience",
      scope: input.scope,
      content: document.content,
      metadata: {
        ...metadata,
        entryStats: stats,
      },
    });
    return {
      activatedEntries: selected.map((entry) => ({
        entryId: entry.id,
        confidence: entry.confidence,
      })),
      outcome,
    };
  }

  async calibrateExperience(input: {
    scope: MemoryScope;
    maxChars?: number;
    recentLimit?: number;
  }): Promise<ExperienceCalibrationResult> {
    const document = await this.options.active.read("experience", input.scope);
    if (!document?.content.trim()) {
      return {
        driftDetected: false,
        zombieRemoved: [],
        harmfulFlagged: [],
        coreConfirmed: [],
      };
    }
    const metadata = readExperienceMetadata(document);
    const stats = mergeEntryStats(
      parseExperienceEntries(document.content),
      metadata.entryStats ?? [],
      this.now().toISOString(),
    );
    const recentFragments = await this.loadRecentFragments(input.scope, input.recentLimit ?? 24);
    const heuristic = analyzeExperienceStats(stats, recentFragments);
    const inference = await this.infer({
      kind: "calibration",
      system:
        "Calibrate the active experience document. Remove stale or harmful items, keep effective durable lessons, and output only the corrected experience document.",
      prompt: buildCalibrationPrompt(document.content, stats, recentFragments),
      currentContent: document.content,
      maxChars: input.maxChars ?? document.content.length,
    });
    const nextContent = inference.ok
      ? clampChars(inference.text, input.maxChars ?? Math.max(document.content.length, 800))
      : applyHeuristicCalibration(document.content, heuristic.zombieRemoved);
    await this.options.active.write({
      kind: "experience",
      scope: input.scope,
      content: nextContent,
      metadata: {
        ...metadata,
        entryStats: stats.filter((entry) => !heuristic.zombieRemoved.includes(entry.text)),
        lastCalibrationAt: this.now().toISOString(),
      },
    });
    return {
      driftDetected: inference.ok ? normalizeText(nextContent) !== normalizeText(document.content) : heuristic.zombieRemoved.length > 0,
      driftReport:
        inference.ok
          ? "Experience document recalibrated with inferencer guidance"
          : heuristic.zombieRemoved.length > 0
            ? `Removed ${heuristic.zombieRemoved.length} stale experience entries`
            : undefined,
      zombieRemoved: heuristic.zombieRemoved,
      harmfulFlagged: heuristic.harmfulFlagged,
      coreConfirmed: heuristic.coreConfirmed,
    };
  }

  async rebuildExperience(input: {
    scope: MemoryScope;
    maxChars?: number;
    recentLimit?: number;
  }): Promise<ExperienceRebuildResult> {
    const document = await this.options.active.read("experience", input.scope);
    const fragments = await this.loadRecentFragments(input.scope, input.recentLimit ?? 36);
    const fallback = clampChars(
      dedupeLines(
        [
          document?.content ?? "",
          ...fragments,
        ].join("\n"),
      ),
      input.maxChars ?? 800,
    );
    const result = await this.infer({
      kind: "experience",
      system:
        "Rebuild a compact reusable experience document from recent long-term memory fragments. Keep only durable lessons, strategies, and warnings.",
      prompt: [
        "## Current experience",
        document?.content?.trim() || "(empty)",
        "",
        "## Recent memory fragments",
        fragments.join("\n"),
      ].join("\n"),
      currentContent: document?.content,
      maxChars: input.maxChars ?? 800,
    });
    const content = result.ok ? clampChars(result.text, input.maxChars ?? 800) : fallback;
    await this.options.active.write({
      kind: "experience",
      scope: input.scope,
      content,
      metadata: {
        ...readExperienceMetadata(document),
        entryStats: mergeEntryStats(
          parseExperienceEntries(content),
          readExperienceMetadata(document).entryStats ?? [],
          this.now().toISOString(),
        ),
        lastRebuildAt: this.now().toISOString(),
      },
    });
    return {
      content,
      sourceFragments: fragments,
    };
  }

  async deepConsolidate(input: {
    scope: MemoryScope;
    maxChars?: number;
    recentLimit?: number;
  }): Promise<{
    rebuild: ExperienceRebuildResult;
    calibration: ExperienceCalibrationResult;
  }> {
    const rebuild = await this.rebuildExperience(input);
    const calibration = await this.calibrateExperience(input);
    return { rebuild, calibration };
  }

  private async loadRecentFragments(scope: MemoryScope, limit: number): Promise<string[]> {
    const records = await this.options.memory.list({
      scopes: [scope],
      limit,
    });
    return records
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((record) => record.summary?.trim() || record.content.trim())
      .filter(Boolean)
      .slice(0, limit);
  }

  private async selectActivatedEntries(
    entries: Array<{ id: string; text: string }>,
    response: string,
  ): Promise<Array<{ id: string; confidence: number }>> {
    const candidates = prefilterEntries(entries, response);
    if (candidates.length === 0) {
      return [];
    }
    const result = await this.infer({
      kind: "attribution",
      system:
        "Given an agent response and numbered experience entries, output only the numbers of the entries that influenced the response, comma-separated. Output NONE if nothing applies.",
      prompt: [
        "## Agent response",
        response.trim(),
        "",
        "## Candidate experiences",
        candidates.map((entry, index) => `${index + 1}. ${entry.text}`).join("\n"),
      ].join("\n"),
      maxChars: 64,
    });
    if (!result.ok) {
      return candidates.map((entry) => ({
        id: entry.id,
        confidence: entry.confidence,
      }));
    }
    const text = result.text.trim();
    if (!text || /^none$/i.test(text)) {
      return [];
    }
    const indices = text
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10) - 1)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < candidates.length);
    return indices.map((index) => ({
      id: candidates[index]!.id,
      confidence: 0.8,
    }));
  }

  private async infer(input: {
    kind: "attribution" | "calibration" | "experience";
    system: string;
    prompt: string;
    maxChars: number;
    currentContent?: string;
  }): Promise<MemoryInferencerResult> {
    if (!this.options.inferencer) {
      return { ok: false, error: "No inferencer configured" };
    }
    return await this.options.inferencer({
      kind: input.kind === "experience" ? "experience" : input.kind,
      system: input.system,
      prompt: input.prompt,
      maxChars: input.maxChars,
      currentContent: input.currentContent,
    });
  }
}

function readExperienceMetadata(document: ActiveMemoryDocument | null): ExperienceMetadata {
  const metadata = document?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return {};
  }
  return metadata as ExperienceMetadata;
}

function parseExperienceEntries(content: string): Array<{ id: string; text: string }> {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)
    .map((text) => ({
      id: simpleHash(text),
      text,
    }));
}

function mergeEntryStats(
  entries: Array<{ id: string; text: string }>,
  existing: ExperienceEntryStat[],
  nowIso: string,
): ExperienceEntryStat[] {
  const byId = new Map(existing.map((entry) => [entry.id, { ...entry }]));
  for (const entry of entries) {
    const current = byId.get(entry.id);
    if (current) {
      current.text = entry.text;
      continue;
    }
    byId.set(entry.id, {
      id: entry.id,
      text: entry.text,
      activationCount: 0,
      positiveCount: 0,
      firstSeenAt: nowIso,
    });
  }
  return [...byId.values()];
}

function prefilterEntries(
  entries: Array<{ id: string; text: string }>,
  response: string,
): Array<{ id: string; text: string; confidence: number }> {
  const responseTokens = tokenize(response);
  if (responseTokens.size === 0) {
    return [];
  }
  return entries
    .map((entry) => ({
      ...entry,
      confidence: jaccardSimilarity(tokenize(entry.text), responseTokens),
    }))
    .filter((entry) => entry.confidence >= 0.12)
    .toSorted((left, right) => right.confidence - left.confidence)
    .slice(0, 5);
}

function analyzeExperienceStats(stats: ExperienceEntryStat[], recentFragments: string[]) {
  const recentText = recentFragments.join("\n").toLowerCase();
  const zombieRemoved: string[] = [];
  const harmfulFlagged: string[] = [];
  const coreConfirmed: string[] = [];
  for (const stat of stats) {
    if (stat.activationCount === 0 && !recentText.includes(stat.text.toLowerCase())) {
      zombieRemoved.push(stat.text);
      continue;
    }
    if (stat.activationCount >= 5) {
      const ratio = stat.positiveCount / Math.max(1, stat.activationCount);
      if (ratio < 0.3) {
        harmfulFlagged.push(stat.text);
      } else if (ratio > 0.7) {
        coreConfirmed.push(stat.text);
      }
    }
  }
  return { zombieRemoved, harmfulFlagged, coreConfirmed };
}

function applyHeuristicCalibration(content: string, removals: string[]): string {
  if (removals.length === 0) {
    return content;
  }
  const blocked = new Set(removals.map(normalizeText));
  return content
    .split(/\r?\n/)
    .filter((line) => !blocked.has(normalizeText(line.replace(/^[-*]\s+/, ""))))
    .join("\n")
    .trim();
}

function buildCalibrationPrompt(
  content: string,
  stats: ExperienceEntryStat[],
  recentFragments: string[],
): string {
  return [
    "## Current experience",
    content.trim(),
    "",
    "## Entry stats",
    stats
      .map(
        (entry) =>
          `- ${entry.text} | a:${entry.activationCount} p:${entry.positiveCount} firstSeen:${entry.firstSeenAt}`,
      )
      .join("\n"),
    "",
    "## Recent palace fragments",
    recentFragments.join("\n"),
  ].join("\n");
}

function clampChars(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content.trim();
  }
  return content.slice(0, maxChars).trimEnd();
}

function dedupeLines(content: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const key = normalizeText(line);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(line);
  }
  return lines.join("\n");
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union > 0 ? intersection / union : 0;
}

function tokenize(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

function normalizeText(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function simpleHash(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) - hash + content.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}
