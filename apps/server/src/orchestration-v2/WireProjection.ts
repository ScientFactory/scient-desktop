import { presentProviderCitationText } from "./providerCitationMarkdown.ts";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { compactDynamicToolOutput, toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_HISTORICAL_TASK_TEXT_BYTES = 1_024;
const HistoricalTaskActivity = Schema.Struct({
  activityId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  tone: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  sequence: Schema.NullOr(Schema.Number),
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeHistoricalTaskActivity = Schema.decodeUnknownOption(HistoricalTaskActivity);
const TaskPhases = Schema.Array(Schema.Struct({ index: Schema.Number, title: Schema.String }));
const decodeTaskPhases = Schema.decodeUnknownOption(TaskPhases);
const TaskUsage = Schema.Struct({
  totalTokens: Schema.optionalKey(Schema.Number),
  inputTokens: Schema.optionalKey(Schema.Number),
  cachedInputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  reasoningOutputTokens: Schema.optionalKey(Schema.Number),
  toolUses: Schema.optionalKey(Schema.Number),
  durationMs: Schema.optionalKey(Schema.Number),
});
const decodeTaskUsage = Schema.decodeUnknownOption(TaskUsage);
const TaskRunHandles = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  scriptPath: Schema.optionalKey(Schema.String),
  transcriptDir: Schema.optionalKey(Schema.String),
  sessionUrl: Schema.optionalKey(Schema.String),
});
const decodeTaskRunHandles = Schema.decodeUnknownOption(TaskRunHandles);
const taskIdentityFields = new Set([
  "taskId",
  "agentId",
  "parentAgentId",
  "taskType",
  "agentKind",
  "status",
  "endedAt",
  "outputFile",
]);

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // UTF-8 needs at least one byte per UTF-16 code unit. Only encode the prefix
  // that could fit, rather than allocating a buffer for the complete output.
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… output truncated for transport`;
}

/** Historical roster facts retain their envelope; only display text is abbreviated. */
function projectHistoricalTaskInput(
  item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
) {
  if (item.runId !== null || item.nodeId !== null || item.nativeItemRef !== null) return undefined;
  const decoded = decodeHistoricalTaskActivity(item.input);
  if (Option.isNone(decoded)) return undefined;
  const record = decoded.value;
  if (
    !record.kind.startsWith("task.") ||
    (item.inheritedFrom?.itemId ?? item.id) !== `migration:v1:history:activity:${record.activityId}`
  )
    return undefined;
  const text = (value: string) => {
    if (Buffer.byteLength(value, "utf8") <= MAX_HISTORICAL_TASK_TEXT_BYTES) return value;
    // Include the marker in this limit so projecting an already shortened record is stable.
    return (
      truncateDetail(
        value,
        MAX_HISTORICAL_TASK_TEXT_BYTES -
          Buffer.byteLength("\n… output truncated for transport", "utf8"),
      ) ?? ""
    );
  };
  const payload = Object.fromEntries(
    Object.entries(record.payload).map(([key, value]) => {
      if (taskIdentityFields.has(key)) return [key, value];
      if (key === "typedUsage") {
        const usage = decodeTaskUsage(value);
        if (Option.isSome(usage)) return [key, usage.value];
      }
      if (key === "phases") {
        const phases = decodeTaskPhases(value);
        if (Option.isSome(phases))
          return [key, phases.value.map((phase) => ({ ...phase, title: text(phase.title) }))];
      }
      if (key === "runHandles") {
        const handles = decodeTaskRunHandles(value);
        if (Option.isSome(handles)) return [key, handles.value];
      }
      return [key, typeof value === "string" ? text(value) : summarizeDynamicValue(value)];
    }),
  );
  return { ...record, summary: text(record.summary), payload };
}

function summarizeDynamicValue(value: unknown): unknown {
  let serialized: string;
  try {
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_BYTES) {
      serialized = value;
    } else {
      const json = JSON.stringify(value) ?? String(value);
      if (Buffer.byteLength(json, "utf8") <= MAX_DYNAMIC_VALUE_BYTES) {
        return value;
      }
      serialized = typeof value === "string" ? value : json;
    }
  } catch {
    serialized = "Unserializable tool output";
  }

  // Preserve the first nonblank normalized line, but stop after the preview.
  // Splitting and normalizing every line can allocate far more than the input.
  const start = /\S/u.exec(serialized)?.index;
  let firstLine = start === undefined ? "Large tool output" : "";
  let pendingSpace = false;
  for (let index = start ?? serialized.length; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (character === "\n") break;
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) firstLine += " ";
    firstLine += character;
    pendingSpace = false;
    if (firstLine.length > 160) break;
  }
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    // SCIENT-FORK:START — citation fallback is presentation, never a stored-text repair.
    case "assistant_message": {
      const text = presentProviderCitationText(item);
      return text === item.text ? item : { ...item, text };
    }
    // SCIENT-FORK:END
    case "handoff": {
      const { summary: _summary, ...projected } = item;
      return projected;
    }
    case "command_execution": {
      const { output, ...projected } = item;
      // Clients used this preview to recognize provider-reported failures. Keep
      // the outcome without retaining or serializing the output that proved it.
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (output !== undefined &&
          toolOutputIndicatesFailure(output.slice(0, MAX_DETAIL_STRING_BYTES)));
      return failed ? { ...projected, outputIndicatesFailure: true } : projected;
    }
    case "file_change": {
      // File identity and counts are enough for activity. Full diffs already
      // have a dedicated read path and remain intact in persistence.
      const { diffStr: _diff, oldStr: _old, newStr: _new, ...projected } = item;
      return projected;
    }
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool": {
      const { output: rawOutput, ...projected } = item;
      const output = compactDynamicToolOutput(rawOutput);
      return {
        ...projected,
        input: projectHistoricalTaskInput(item) ?? summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
      };
    }
    default:
      return item;
  }
}

// SCIENT-FORK:START — message and item clients share one raw-to-display citation projection.
function projectMessageForWire(
  message: OrchestrationV2ConversationMessage,
): OrchestrationV2ConversationMessage {
  if (message.role !== "assistant") return message;
  const text = presentProviderCitationText(message);
  return text === message.text ? message : { ...message, text };
}

// SCIENT-FORK:END

export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, ...projected } = handoff;
  return { ...projected, summaryText: "" };
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    // SCIENT-FORK: use the same presentation for snapshot messages and visible items.
    messages: projection.messages.map(projectMessageForWire),
    contextHandoffs: projection.contextHandoffs.map(projectContextHandoffForWire),
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  // SCIENT-FORK: event delivery uses the same citation presentation as snapshot delivery.
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event.type === "message.updated"
      ? { ...event, payload: projectMessageForWire(event.payload) }
      : event.type === "context-handoff.updated"
        ? { ...event, payload: projectContextHandoffForWire(event.payload) }
        : event;
}
