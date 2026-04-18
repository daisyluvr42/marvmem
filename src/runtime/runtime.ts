import { type MarvMem } from "../core/memory.js";
import type { MemoryInput, MemoryRecord, MemoryScope } from "../core/types.js";
import type {
  CapturedMemoryProposal,
  MemoryCaptureResult,
  MemoryRuntime,
  MemoryRuntimeOptions,
  MemoryTurnInput,
} from "./types.js";

export function createMemoryRuntime(params: {
  memory: MarvMem;
  defaultScopes?: MemoryScope[];
  maxRecallChars?: number;
}): MemoryRuntime {
  const options: MemoryRuntimeOptions = {
    defaultScopes: params.defaultScopes,
    maxRecallChars: params.maxRecallChars ?? 4_000,
  };

  return {
    async buildRecallContext(turn: MemoryTurnInput) {
      return await params.memory.recall({
        query: turn.userMessage,
        recentMessages: turn.recentMessages,
        scopes: resolveScopes(turn.scopes, options.defaultScopes),
        maxChars: turn.maxChars ?? options.maxRecallChars,
      });
    },

    async captureTurn(turn: MemoryTurnInput): Promise<MemoryCaptureResult> {
      const proposals = inferMemoryProposals(turn);
      const scopes = resolveScopes(turn.scopes, options.defaultScopes);
      if (scopes.length === 0) {
        return { proposals, stored: [] };
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
      return { proposals, stored };
    },

    async captureReflection(input) {
      const scopes = resolveScopes(input.scopes, options.defaultScopes);
      const scope = scopes[0];
      if (!scope || !input.summary.trim()) {
        return null;
      }
      return await params.memory.remember({
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
    },

    buildSystemHint() {
      return [
        "Use long-term memory when answering questions about prior decisions, preferences, identity, or past work.",
        "When relevant, inject recalled memory into the prompt before the main answer.",
        "Persist durable user preferences and explicit remember requests after the turn.",
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
  const explicitRemember = stripLeadingCue(
    text,
    /^(remember(?: that| this)?|please remember|记住|记一下|请记住)\s*[:,\-]?\s*/iu,
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
    proposals.push({
      kind: "preference",
      content: text,
      summary: text,
      confidence: 0.82,
      importance: 0.8,
      source: "turn_inference",
      tags: ["preference"],
    });
  }

  if (/(we decided|let'?s use|we will use|改用|我们决定|我们以后用)/iu.test(text)) {
    proposals.push({
      kind: "decision",
      content: text,
      summary: text,
      confidence: 0.78,
      importance: 0.78,
      source: "turn_inference",
      tags: ["decision"],
    });
  }

  if (/(my name is|i am |我是|我的名字是)/iu.test(text)) {
    proposals.push({
      kind: "identity",
      content: text,
      summary: text,
      confidence: 0.76,
      importance: 0.75,
      source: "turn_inference",
      tags: ["identity"],
    });
  }

  return dedupeProposals(proposals);
}

function stripLeadingCue(value: string, pattern: RegExp): string | null {
  const stripped = value.replace(pattern, "").trim();
  return stripped && stripped !== value ? stripped : null;
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
