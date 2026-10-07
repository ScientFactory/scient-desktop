import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentPresentation,
} from "@t3tools/contracts";

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
const WORKFLOW_PHASE_CAP = 64;
const WORKFLOW_AGENT_CAP = 100;

export interface ClaudeWorkflowAgentEntry {
  readonly index: number;
  readonly state: string;
  readonly label: string | undefined;
  readonly phaseIndex: number | undefined;
  readonly phaseTitle: string | undefined;
  readonly model: string | undefined;
  readonly attempt: number | undefined;
  readonly lastToolName: string | undefined;
  readonly startedAt: string | undefined;
  readonly error: string | undefined;
  readonly tokens: number | undefined;
  readonly toolCalls: number | undefined;
}

export interface ClaudeWorkflowProgress {
  readonly phases: ReadonlyArray<{ index: number; title: string }>;
  readonly agents: ReadonlyArray<ClaudeWorkflowAgentEntry>;
}

/**
 * Defensive parse of the SDK's undeclared-but-real workflow_progress array on
 * task_progress messages (wire-confirmed; absent from sdk.d.ts). Unknown
 * shapes are skipped per-entry; phases and agents dedupe by index before
 * caps; a vanished field never throws. If the array disappears upstream the
 * caller keeps the coordinator row and plain task lifecycle.
 */
export function parseWorkflowProgress(value: unknown): ClaudeWorkflowProgress | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const phasesByIndex = new Map<number, string>();
  const agentsByIndex = new Map<number, ClaudeWorkflowAgentEntry>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const entryType = trimmedString(record.type);
    if (entryType === "workflow_phase") {
      const index = nonNegativeInt(record.index);
      const title = trimmedString(record.title);
      if (index !== undefined && title && !phasesByIndex.has(index)) {
        phasesByIndex.set(index, title);
      }
      continue;
    }
    if (entryType !== "workflow_agent") {
      continue;
    }
    const index = nonNegativeInt(record.index);
    const state = trimmedString(record.state);
    if (index === undefined || !state || agentsByIndex.has(index)) {
      continue;
    }
    agentsByIndex.set(index, {
      index,
      state,
      label: trimmedString(record.label),
      phaseIndex: nonNegativeInt(record.phaseIndex),
      phaseTitle: trimmedString(record.phaseTitle),
      model: trimmedString(record.model),
      attempt: nonNegativeInt(record.attempt),
      lastToolName: trimmedString(record.lastToolName),
      startedAt: trimmedString(record.startedAt),
      error: trimmedString(record.error),
      tokens: nonNegativeInt(record.tokens),
      toolCalls: nonNegativeInt(record.toolCalls),
    });
  }
  if (phasesByIndex.size === 0 && agentsByIndex.size === 0) {
    return undefined;
  }
  const phases = Array.from(phasesByIndex.entries())
    .map(([index, title]) => ({ index, title }))
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_PHASE_CAP);
  const agents = Array.from(agentsByIndex.values())
    .toSorted((a, b) => a.index - b.index)
    .slice(0, WORKFLOW_AGENT_CAP);
  return { phases, agents };
}

/**
 * Workflow member states from workflow_progress → shared task status.
 * Unknown states read running after startedAt, pending before it.
 */
export function workflowAgentStatus(
  entry: ClaudeWorkflowAgentEntry,
): OrchestrationV2Subagent["status"] {
  switch (entry.state) {
    case "queued":
    case "pending":
      return "pending";
    case "start":
    case "running":
      return entry.startedAt === undefined ? "pending" : "running";
    case "done":
    case "completed":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    case "cancelled":
    case "killed":
      return "cancelled";
    case "paused":
    case "idle":
      return "idle";
    default:
      return entry.startedAt === undefined ? "pending" : "running";
  }
}

/** Native SDK observations are sparse and sometimes absent from its declared union. */
export function claudeTaskPresentation(
  message: unknown,
): Partial<OrchestrationV2SubagentPresentation> {
  const record =
    typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
  const workflow = parseWorkflowProgress(record.workflow_progress);
  const usageRecord =
    typeof record.usage === "object" && record.usage !== null
      ? (record.usage as Record<string, unknown>)
      : {};
  const usageCounts: NonNullable<OrchestrationV2SubagentPresentation["usage"]> = Object.fromEntries(
    [
      ["totalTokens", nonNegativeInt(usageRecord.total_tokens)],
      ["inputTokens", nonNegativeInt(usageRecord.input_tokens)],
      ["cachedInputTokens", nonNegativeInt(usageRecord.cache_read_input_tokens)],
      ["outputTokens", nonNegativeInt(usageRecord.output_tokens)],
      ["toolUses", nonNegativeInt(usageRecord.tool_uses)],
      ["durationMs", nonNegativeInt(usageRecord.duration_ms)],
    ].filter((entry) => entry[1] !== undefined),
  );
  const usage = Object.keys(usageCounts).length === 0 ? undefined : usageCounts;
  const role = trimmedString(record.subagent_type);
  const effort = trimmedString(record.effort);
  const workflowName = trimmedString(record.workflow_name);
  const lastToolName = trimmedString(record.last_tool_name);
  const outputFile = trimmedString(record.output_file);
  return {
    ...(record.task_type === "local_workflow" || workflow !== undefined
      ? { kind: "workflow" as const }
      : {}),
    ...(role === undefined ? {} : { role }),
    ...(effort === undefined ? {} : { effort }),
    ...(workflowName === undefined ? {} : { workflowName }),
    ...(lastToolName === undefined ? {} : { lastToolName }),
    ...(outputFile === undefined ? {} : { outputFile }),
    ...(usage === undefined ? {} : { usage }),
    ...(workflow === undefined ? {} : { phases: workflow.phases }),
  };
}

export function claudeWorkflowRunHandles(value: unknown):
  | {
      taskId: string;
      presentation: Partial<OrchestrationV2SubagentPresentation>;
    }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const taskId = trimmedString(record.taskId);
  if (taskId === undefined) return undefined;
  const runId = trimmedString(record.runId);
  const scriptPath = trimmedString(record.scriptPath);
  const transcriptDir = trimmedString(record.transcriptDir);
  let sessionUrl: string | undefined;
  const suppliedUrl = trimmedString(record.sessionUrl);
  if (suppliedUrl !== undefined) {
    try {
      const parsed = new URL(suppliedUrl);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.username === "" &&
        parsed.password === ""
      )
        sessionUrl = parsed.href;
    } catch {
      /* Malformed native display URLs are ignored. */
    }
  }
  return {
    taskId,
    presentation: {
      kind: "workflow",
      runHandles: {
        ...(runId === undefined ? {} : { runId }),
        ...(scriptPath === undefined ? {} : { scriptPath }),
        ...(transcriptDir === undefined ? {} : { transcriptDir }),
        ...(sessionUrl === undefined ? {} : { sessionUrl }),
      },
    },
  };
}
