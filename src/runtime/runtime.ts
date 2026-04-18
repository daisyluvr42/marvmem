import { type MarvMem } from "../core/memory.js";
import type { MemoryInput, MemoryRecord, MemoryScope } from "../core/types.js";
import type { TaskContextEntry } from "../task/types.js";
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
        },
      };
    },

    async captureTurn(turn: MemoryTurnInput): Promise<MemoryCaptureResult> {
      const proposals = inferMemoryProposals(turn);
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
