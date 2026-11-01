export interface RuntimeCitationSource {
  readonly id: string;
  readonly url: string;
  readonly title?: string | undefined;
}

export interface RuntimeTextCitation {
  readonly start: number;
  readonly end: number;
  readonly sourceIds: ReadonlyArray<string>;
}

/**
 * Watch-loop task types: Monitor-tool tasks plus background shells (a shell
 * that outlives its turn is in practice a watch loop). Canonical single copy —
 * the server liveness registry, ingestion's agentKind stamp, and the client
 * fold's legacy fallback all classify with these sets.
 */
export const MONITOR_TASK_TYPES: ReadonlySet<string> = new Set([
  "monitor",
  "monitor_mcp",
  "local_bash",
  "shell",
]);
/** Task types that are neither agents nor watch loops (plan-mode bookkeeping). */
export const INERT_TASK_TYPES: ReadonlySet<string> = new Set(["plan", "dream"]);

/**
 * Use a background denylist because SDK agent type names drift and allowlists silently lose subagents.
 * Nested agent-flavored tasks remain roster agents even with agentId; other child work stays background.
 */
export function classifyTaskAgentKind(input: {
  readonly taskType?: string | undefined;
  readonly agentId?: string | undefined;
}): "agent" | "background" {
  const { taskType, agentId } = input;
  const nonAgentType =
    taskType !== undefined && (MONITOR_TASK_TYPES.has(taskType) || INERT_TASK_TYPES.has(taskType));
  if (agentId !== undefined && agentId.trim().length > 0) {
    return taskType === undefined || nonAgentType ? "background" : "agent";
  }
  return nonAgentType ? "background" : "agent";
}
