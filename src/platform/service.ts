import type { MarvMem } from "../core/memory.js";
import type { MemoryInput, MemoryRecallResult, MemoryRecord } from "../core/types.js";
import type { MemoryCaptureResult, MemoryProposalExtractor, MemoryRuntime } from "../runtime/types.js";
import { createMemoryRuntime, inferMemoryProposals } from "../runtime/runtime.js";
import type { InspectEventStore } from "../inspect/types.js";
import type { PlanGate } from "../cloud/gate.js";
import type { UsageMeter } from "../cloud/usage.js";
import type { CloudSyncManager } from "../cloud/sync.js";
import type { Plan } from "../cloud/types.js";
import {
  resolveContextScopes,
  canonicalTaskId,
  filterScopesByTargets,
  recordBelongsToProject,
} from "./context.js";
import type {
  CaptureTurnInput,
  ListMemoriesInput,
  MemoryContext,
  MemoryRecordRef,
  PlatformMemoryService,
  RecallInput,
  RecallInspection,
  ResolvedScopes,
  UpdateMemoryInput,
  WriteMemoryInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type MarvMemPlatformServiceOptions = {
  memory: MarvMem;
  events?: InspectEventStore;
  /** Cloud infrastructure (optional, required for Pro/Team features) */
  cloud?: {
    gate: PlanGate;
    usage: UsageMeter;
    sync?: CloudSyncManager;
    /** Resolve project plan. Defaults to 'free'. */
    getPlan?: (projectId: string) => Promise<Plan>;
  };
  proposalExtractor?: MemoryProposalExtractor;
};

export class MarvMemPlatformService implements PlatformMemoryService {
  private readonly memory: MarvMem;
  private readonly events?: InspectEventStore;
  private readonly cloud?: MarvMemPlatformServiceOptions["cloud"];
  private readonly proposalExtractor?: MemoryProposalExtractor;

  constructor(options: MarvMemPlatformServiceOptions) {
    this.memory = options.memory;
    this.events = options.events;
    this.cloud = options.cloud;
    this.proposalExtractor = options.proposalExtractor;
  }

  // -----------------------------------------------------------------------
  // Cloud helpers
  // -----------------------------------------------------------------------

  private async getProjectPlan(projectId: string): Promise<Plan> {
    return this.cloud?.getPlan
      ? this.cloud.getPlan(projectId)
      : "free";
  }

  private async guardWrite(projectId: string): Promise<void> {
    if (!this.cloud) return;
    const plan = await this.getProjectPlan(projectId);
    await this.cloud.gate.assert(projectId, plan, "write_memory");
  }

  private async trackWrite(projectId: string): Promise<void> {
    if (!this.cloud) return;
    await this.cloud.usage.increment(projectId, "memoriesWritten");
  }

  // -----------------------------------------------------------------------
  // Scope resolution
  // -----------------------------------------------------------------------

  resolveContextScopes(context: MemoryContext): ResolvedScopes {
    return resolveContextScopes(context);
  }

  // -----------------------------------------------------------------------
  // Turn lifecycle
  // -----------------------------------------------------------------------

  async captureTurn(input: CaptureTurnInput): Promise<MemoryCaptureResult> {
    const resolvedScopes = resolveContextScopes(input.context);
    const { writeScope, recallScopes } = resolvedScopes;
    const taskKey = canonicalTaskId(input.context);
    const taskScope = recallScopes.find((scope) => scope.type === "task");
    const userScope = recallScopes.find((scope) => scope.type === "user");
    const lifecycleScopes = [writeScope, ...recallScopes.filter((scope) => !sameScope(scope, writeScope))];
    const rawProposals = this.proposalExtractor
      ? await this.proposalExtractor.extract({
          userMessage: input.userMessage,
          assistantMessage: input.assistantMessage,
          recentMessages: input.recentMessages,
          scopes: lifecycleScopes,
          taskId: taskKey,
          taskTitle: input.taskTitle,
          toolContext: input.toolContext,
        })
      : inferMemoryProposals({
          userMessage: input.userMessage,
          assistantMessage: input.assistantMessage,
          recentMessages: input.recentMessages,
          scopes: lifecycleScopes,
          taskId: taskKey,
          taskTitle: input.taskTitle,
          toolContext: input.toolContext,
        });
    const proposals = rawProposals.map((proposal) => ({
      ...proposal,
      metadata: { ...(proposal.metadata ?? {}), projectId: input.context.projectId },
      scopes: [
        selectDurableScopeForProposal(proposal.kind, {
          writeScope,
          taskScope,
          userScope,
        }),
      ],
    }));

    const runtime = this.buildRuntime(lifecycleScopes);
    const result = await runtime.captureTurn({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      recentMessages: input.recentMessages,
      scopes: lifecycleScopes,
      proposals,
      taskId: taskKey,
      taskTitle: input.taskTitle,
      toolContext: input.toolContext,
    });

    if (this.events && result.stored.length > 0) {
      for (const record of result.stored) {
        this.events.emit({
          type: "memory_written",
          context: input.context,
          data: { recordId: record.id, kind: record.kind },
        });
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Recall
  // -----------------------------------------------------------------------

  async buildRecall(input: RecallInput): Promise<MemoryRecallResult> {
    const { recallScopes } = resolveContextScopes(input.context);
    const taskKey = canonicalTaskId(input.context);

    const runtime = this.buildRuntime(recallScopes);
    const result = await runtime.buildRecallContext({
      userMessage: input.message,
      recentMessages: input.recentMessages,
      scopes: recallScopes,
      maxChars: input.maxChars,
      taskId: taskKey,
      toolContext: input.toolContext,
    });

    if (this.events) {
      this.events.emit({
        type: "recall_built",
        context: input.context,
        data: {
          query: input.message,
          hitCount: result.hits.length,
          contextLength: result.injectedContext.length,
        },
      });
    }

    return result;
  }

  async inspectRecall(input: RecallInput): Promise<RecallInspection> {
    const result = await this.buildRecall(input);
    return {
      context: input.context,
      message: input.message,
      injectedContext: result.injectedContext,
      layers: result.layers,
      hits: result.hits,
    };
  }

  // -----------------------------------------------------------------------
  // Memory CRUD
  // -----------------------------------------------------------------------

  async writeMemory(input: WriteMemoryInput): Promise<MemoryRecord> {
    const { writeScope } = resolveContextScopes(input.context);

    // Cloud: check write quota before proceeding
    const projectId = input.context.projectId ?? "default";
    await this.guardWrite(projectId);

    const memoryInput: MemoryInput = {
      scope: writeScope,
      kind: input.kind,
      content: input.content,
      summary: input.summary,
      confidence: input.confidence,
      importance: input.importance,
      source: input.source,
      tags: input.tags,
      metadata: { ...(input.metadata ?? {}), projectId },
    };

    const record = await this.memory.remember(memoryInput);

    // Cloud: track usage + async sync push
    await this.trackWrite(projectId);
    this.cloud?.sync?.push(projectId).catch(() => {/* best effort */});

    if (this.events) {
      this.events.emit({
        type: "memory_written",
        context: input.context,
        data: { recordId: record.id, kind: record.kind },
      });
    }

    return record;
  }

  async listMemories(input: ListMemoriesInput): Promise<MemoryRecord[]> {
    const scopes = filterScopesByTargets(input.context, input.scopeTargets);

    let records = await this.memory.list({
      scopes,
    });

    // Filter by kind if specified
    if (input.kinds && input.kinds.length > 0) {
      const kindSet = new Set(input.kinds);
      records = records.filter((record) => kindSet.has(record.kind));
    }

    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map((tag) => tag.toLowerCase()));
      records = records.filter((record) => record.tags.some((tag) => tagSet.has(tag.toLowerCase())));
    }

    if (input.metadata && Object.keys(input.metadata).length > 0) {
      records = records.filter((record) =>
        Object.entries(input.metadata!).every(([key, value]) => record.metadata?.[key] === value),
      );
    }

    // Simple cursor-based pagination: cursor is the last-seen record id.
    // Skip records until we pass the cursor id, then return `limit` records.
    if (input.cursor) {
      const cursorIndex = records.findIndex((r) => r.id === input.cursor);
      if (cursorIndex >= 0) {
        records = records.slice(cursorIndex + 1);
      }
    }

    if (input.limit && input.limit > 0) {
      records = records.slice(0, input.limit);
    }

    return records;
  }

  async getMemory(input: MemoryRecordRef): Promise<MemoryRecord | null> {
    const record = await this.memory.get(input.id);
    if (!record) {
      return null;
    }

    // Project isolation: verify the record belongs to this project context
    if (!recordBelongsToProject(record, input.context)) {
      return null;
    }

    return record;
  }

  async updateMemory(input: {
    ref: MemoryRecordRef;
    patch: UpdateMemoryInput;
  }): Promise<MemoryRecord | null> {
    // Project isolation check
    const existing = await this.getMemory(input.ref);
    if (!existing) {
      return null;
    }

    const result = await this.memory.update(input.ref.id, {
      kind: input.patch.kind,
      content: input.patch.content,
      summary: input.patch.summary,
      confidence: input.patch.confidence,
      importance: input.patch.importance,
      source: input.patch.source,
      tags: input.patch.tags,
      metadata: input.patch.metadata,
    });

    if (this.events && result) {
      this.events.emit({
        type: "memory_updated",
        context: input.ref.context,
        data: { recordId: input.ref.id },
      });
    }

    return result;
  }

  async deleteMemory(input: MemoryRecordRef): Promise<boolean> {
    // Project isolation check
    const existing = await this.getMemory(input);
    if (!existing) {
      return false;
    }

    const deleted = await this.memory.forget(input.id);

    if (this.events && deleted) {
      this.events.emit({
        type: "memory_deleted",
        context: input.context,
        data: { recordId: input.id },
      });
    }

    return deleted;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private buildRuntime(scopes: import("../core/types.js").MemoryScope[]): MemoryRuntime {
    return createMemoryRuntime({
      memory: this.memory,
      defaultScopes: scopes,
    });
  }
}

function selectDurableScopeForProposal(
  kind: string,
  scopes: {
    writeScope: import("../core/types.js").MemoryScope;
    taskScope?: import("../core/types.js").MemoryScope;
    userScope?: import("../core/types.js").MemoryScope;
  },
): import("../core/types.js").MemoryScope {
  if ((kind === "preference" || kind === "identity") && scopes.userScope) {
    return scopes.userScope;
  }
  if (kind === "decision" && scopes.taskScope) {
    return scopes.taskScope;
  }
  return scopes.writeScope;
}

function sameScope(
  left: import("../core/types.js").MemoryScope,
  right: import("../core/types.js").MemoryScope,
): boolean {
  return left.type === right.type && left.id === right.id;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlatformService(
  options: MarvMemPlatformServiceOptions,
): PlatformMemoryService {
  return new MarvMemPlatformService(options);
}
