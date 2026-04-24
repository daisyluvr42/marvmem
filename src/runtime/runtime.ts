import { type MarvMem } from "../core/memory.js";
import type { MemoryInput, MemoryRecord, MemoryScope } from "../core/types.js";
import type { MemoryInferencer } from "../system/types.js";
import type { TaskContextEntry } from "../task/types.js";
import type {
  CapturedMemoryProposal,
  MemoryCaptureResult,
  MemoryProposalExtractor,
  MemoryProposalExtractorInput,
  MemoryRuntime,
  MemoryRuntimeOptions,
  MemoryTurnInput,
} from "./types.js";

export function createMemoryRuntime(params: {
  memory: MarvMem;
  defaultScopes?: MemoryScope[];
  maxRecallChars?: number;
  proposalExtractor?: MemoryProposalExtractor;
}): MemoryRuntime {
  const options: MemoryRuntimeOptions = {
    defaultScopes: params.defaultScopes,
    maxRecallChars: params.maxRecallChars ?? 4_000,
  };

  return {
    async buildRecallContext(turn: MemoryTurnInput) {
      const scopes = resolveScopes(turn.scopes, options.defaultScopes);
      const maxChars = turn.maxChars ?? options.maxRecallChars ?? 4_000;
      const palaceRecall = await params.memory.recall({
        query: turn.userMessage,
        recentMessages: turn.recentMessages,
        scopes,
        maxChars,
      });
      const retrievalRecall = await params.memory.retrieval.recall(turn.userMessage, {
        scopes,
        maxChars,
      });
      const activeBlocks = (
        await Promise.all(scopes.map(async (scope) => await params.memory.active.formatRecall(scope)))
      )
        .map((block) => block.trim())
        .filter(Boolean);
      const activeLayer = activeBlocks.join("\n\n");
      const taskWindow = turn.taskId
        ? await params.memory.task.buildWindow({
            taskId: turn.taskId,
            currentQuery: turn.userMessage,
            toolContext: turn.toolContext,
            maxChars: Math.max(400, Math.floor(maxChars * 0.35)),
          })
        : null;
      const palaceLayer =
        params.memory.retrieval.backend === "builtin" &&
        params.memory.retrieval.usesRemoteEmbeddings
          ? retrievalRecall.injectedContext
          : palaceRecall.injectedContext;
      const retrievalLayer =
        params.memory.retrieval.backend === "qmd" ? retrievalRecall.injectedContext : undefined;
      return {
        ...palaceRecall,
        injectedContext: [activeLayer, taskWindow?.injectedContext, retrievalLayer, palaceLayer]
          .filter(Boolean)
          .join("\n\n")
          .trim(),
        layers: {
          active: activeLayer || undefined,
          task: taskWindow?.injectedContext || undefined,
          retrieval: retrievalLayer,
          palace: palaceLayer || undefined,
          graph: palaceRecall.layers?.graph,
        },
      };
    },

    async captureTurn(turn: MemoryTurnInput): Promise<MemoryCaptureResult> {
      const proposals = turn.proposals ?? await extractMemoryProposals(params.proposalExtractor, turn);
      const scopes = resolveScopes(turn.scopes, options.defaultScopes);
      const taskEntries: TaskContextEntry[] = [];
      if (turn.taskId && scopes[0]) {
        const task = await params.memory.task.get(turn.taskId);
        if (!task) {
          await params.memory.task.create({
            taskId: turn.taskId,
            scope: scopes[0],
            title: turn.taskTitle?.trim() || turn.taskId,
          });
        }
        const userEntry = await params.memory.task.appendEntry({
          taskId: turn.taskId,
          role: "user",
          content: turn.userMessage,
        });
        if (userEntry) {
          taskEntries.push(userEntry);
        }
        if (turn.assistantMessage?.trim()) {
          const assistantEntry = await params.memory.task.appendEntry({
            taskId: turn.taskId,
            role: "assistant",
            content: turn.assistantMessage,
          });
          if (assistantEntry) {
            taskEntries.push(assistantEntry);
          }
        }
        await params.memory.task.distillRollingSummary({ taskId: turn.taskId });
      }
      if (scopes.length === 0) {
        return { proposals, stored: [], taskEntries };
      }
      const stored: MemoryRecord[] = [];
      for (const proposal of proposals) {
        const scope = proposal.scopes?.[0] ?? scopes[0];
        if (!scope) {
          continue;
        }
        stored.push(
          await params.memory.remember({
            scope,
            kind: proposal.kind,
            content: proposal.content,
            summary: proposal.summary,
            confidence: proposal.confidence,
            importance: proposal.importance,
            source: proposal.source,
            tags: proposal.tags,
            metadata: proposal.metadata,
          }),
        );
      }
      const sessionSummary = [
        ...(turn.recentMessages ?? []),
        `user: ${turn.userMessage.trim()}`,
        turn.assistantMessage?.trim() ? `assistant: ${turn.assistantMessage.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      for (const scope of scopes) {
        if (sessionSummary.trim()) {
          await params.memory.active.distillContext({
            scope,
            sessionSummary,
          });
        }
      }
      return { proposals, stored, taskEntries };
    },

    async captureReflection(input) {
      const scopes = resolveScopes(input.scopes, options.defaultScopes);
      const scope = scopes[0];
      if (!scope || !input.summary.trim()) {
        return null;
      }
      const stored = await params.memory.remember({
        scope,
        kind: "experience",
        content: input.summary.trim(),
        summary: input.summary.trim(),
        confidence: 0.7,
        importance: 0.7,
        source: "reflection",
        tags: input.tags,
        metadata: input.metadata,
      });
      await params.memory.active.distillExperience({
        scope,
        newData: input.summary.trim(),
      });
      if (input.taskId) {
        await params.memory.task.addDecision({
          taskId: input.taskId,
          content: input.summary.trim(),
          metadata: input.metadata,
        });
      }
      return stored;
    },

    buildSystemHint() {
      return [
        "Use layered memory when answering: active context for current work, task context for local decisions, and long-term memory for durable facts and preferences.",
        "Inject recalled memory before the main answer when it materially improves accuracy or continuity.",
        "Persist durable user preferences, explicit remember requests, and reusable lessons after the turn.",
      ].join(" ");
    },
  };
}

export function inferMemoryProposals(turn: MemoryTurnInput): CapturedMemoryProposal[] {
  const text = turn.userMessage.trim();
  if (!text) {
    return [];
  }

  const proposals: CapturedMemoryProposal[] = [];
  const explicitRemember = normalizeMemoryCandidate(
    stripLeadingCue(text, /^(remember(?: that| this)?|please remember|记住|记一下|请记住)\s*[:,\-]?\s*/iu),
  );
  if (explicitRemember) {
    proposals.push({
      kind: "fact",
      content: explicitRemember,
      summary: explicitRemember,
      confidence: 0.92,
      importance: 0.85,
      source: "explicit_remember",
      tags: ["explicit", "remember"],
    });
  }

  if (/(i prefer|i like|please reply|use chinese|use english|我更喜欢|请用|以后用|不要用)/iu.test(text)) {
    const candidate =
      explicitRemember && /(i prefer|i like|please reply|use chinese|use english|我更喜欢|请用|以后用|不要用)/iu.test(explicitRemember)
        ? explicitRemember
        : normalizeMemoryCandidate(text);
    proposals.push({
      kind: "preference",
      content: candidate,
      summary: candidate,
      confidence: 0.82,
      importance: 0.8,
      source: "turn_inference",
      tags: ["preference"],
    });
  }

  if (/(we decided|let'?s use|we will use|改用|我们决定|我们以后用)/iu.test(text)) {
    const candidate = normalizeMemoryCandidate(text);
    proposals.push({
      kind: "decision",
      content: candidate,
      summary: candidate,
      confidence: 0.78,
      importance: 0.78,
      source: "turn_inference",
      tags: ["decision"],
    });
  }

  if (/(my name is|i am |我是|我的名字是)/iu.test(text)) {
    const candidate = normalizeMemoryCandidate(text);
    proposals.push({
      kind: "identity",
      content: candidate,
      summary: candidate,
      confidence: 0.76,
      importance: 0.75,
      source: "turn_inference",
      tags: ["identity"],
    });
  }

  return dedupeProposals(proposals);
}

const MEMORY_EXTRACTION_SYSTEM_PROMPT =
  "Extract durable memory candidates from this turn. Return JSON array only. " +
  "Each item should have kind, content, optional summary, confidence, importance, source, tags, metadata. " +
  "Use kinds like fact, preference, decision, identity, experience. Skip transient chat and guesses.";

export class LlmMemoryProposalExtractor implements MemoryProposalExtractor {
  constructor(private readonly inferencer: MemoryInferencer) {}

  async extract(input: MemoryProposalExtractorInput): Promise<CapturedMemoryProposal[]> {
    const fallback = inferMemoryProposals(input);
    const result = await this.inferencer({
      kind: "memory_extraction",
      system: MEMORY_EXTRACTION_SYSTEM_PROMPT,
      prompt: [
        `User: ${input.userMessage}`,
        input.assistantMessage ? `Assistant: ${input.assistantMessage}` : "",
        input.recentMessages?.length ? `Recent:\n${input.recentMessages.join("\n")}` : "",
        input.toolContext ? `Tool context:\n${input.toolContext}` : "",
      ].filter(Boolean).join("\n\n"),
      maxChars: 2000,
    });
    if (!result.ok) {
      return fallback;
    }
    const parsed = parseProposalArray(result.text);
    return parsed.length > 0 ? dedupeProposals(parsed) : fallback;
  }
}

async function extractMemoryProposals(
  extractor: MemoryProposalExtractor | undefined,
  turn: MemoryTurnInput,
): Promise<CapturedMemoryProposal[]> {
  return extractor ? extractor.extract(turn) : inferMemoryProposals(turn);
}

function stripLeadingCue(value: string, pattern: RegExp): string | null {
  const stripped = value.replace(pattern, "").trim();
  return stripped && stripped !== value ? stripped : null;
}

function normalizeMemoryCandidate(value: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const sentences = trimmed
    .split(/(?<=[.!?。！？])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length < 2) {
    return trimmed;
  }
  const followup = sentences.slice(1).join(" ");
  if (
    !/[?？]/u.test(followup) &&
    !/^(what|which|when|where|why|how|should|can|could|would|will|do|does|did|is|are|am|what's|what is|有没有|是否|要不要|该|应该|怎么|如何|什么|哪|能不能|可不可以)\b/iu.test(
      sentences[1] ?? "",
    )
  ) {
    return trimmed;
  }
  return sentences[0]!;
}

function resolveScopes(primary?: MemoryScope[], fallback?: MemoryScope[]): MemoryScope[] {
  return (primary && primary.length > 0 ? primary : fallback) ?? [];
}

function dedupeProposals(proposals: CapturedMemoryProposal[]): CapturedMemoryProposal[] {
  const seen = new Set<string>();
  const deduped: CapturedMemoryProposal[] = [];
  for (const proposal of proposals) {
    const key = `${proposal.kind}:${proposal.content.trim().toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(proposal);
  }
  return deduped;
}

function parseProposalArray(text: string): CapturedMemoryProposal[] {
  try {
    const parsed = JSON.parse(extractJsonArray(text)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item): CapturedMemoryProposal | null => {
        const content = typeof item.content === "string" ? item.content.trim() : "";
        const kind = typeof item.kind === "string" && item.kind.trim() ? item.kind.trim() : "note";
        if (!content) {
          return null;
        }
        const proposal: CapturedMemoryProposal = {
          kind,
          content,
          summary: typeof item.summary === "string" ? item.summary.trim() : content,
          confidence: typeof item.confidence === "number" ? item.confidence : 0.75,
          importance: typeof item.importance === "number" ? item.importance : 0.65,
          source: typeof item.source === "string" ? item.source : "llm_extraction",
          tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string") : ["llm"],
          metadata: item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
            ? item.metadata as Record<string, unknown>
            : undefined,
        };
        return proposal;
      })
      .filter((proposal): proposal is CapturedMemoryProposal => proposal !== null);
  } catch {
    return [];
  }
}

function extractJsonArray(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1]!.trim();
  const array = text.match(/\[[\s\S]*\]/);
  return array ? array[0] : text.trim();
}
