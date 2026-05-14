import { AGENT_IDS, importSessions, resolveAgentOptions, type AgentId, type AgentInstallOptions, type ResolvedAgentInstallOptions } from "./manager.js";

export const DEFAULT_AGENT_IMPORT_INTERVAL_MS = 15 * 60 * 1000;

export type AgentImportScheduler = {
  runOnce(): Promise<boolean>;
  stop(): void;
};

export type AgentImportSchedulerOptions = {
  agentOptions?: AgentInstallOptions | ResolvedAgentInstallOptions;
  agents?: readonly AgentId[];
  intervalMs?: number;
  runOnStart?: boolean;
  importOne?: (agent: AgentId, options: ResolvedAgentInstallOptions) => Promise<unknown>;
  onError?: (error: unknown) => void;
};

export function startAgentImportScheduler(input: AgentImportSchedulerOptions = {}): AgentImportScheduler {
  const options = resolveAgentOptions(input.agentOptions);
  const agents = [...(input.agents ?? AGENT_IDS)];
  const intervalMs = input.intervalMs ?? DEFAULT_AGENT_IMPORT_INTERVAL_MS;
  const importOne = input.importOne ?? importSessions;
  let running = false;
  let stopped = false;

  async function runOnce(): Promise<boolean> {
    if (running || stopped) {
      return false;
    }
    running = true;
    try {
      for (const agent of agents) {
        await importOne(agent, options);
      }
      return true;
    } catch (error) {
      input.onError?.(error);
      return true;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  if (input.runOnStart) {
    void runOnce();
  }

  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
