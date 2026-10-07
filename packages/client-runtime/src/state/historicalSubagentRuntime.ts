import {
  classifyTaskAgentKind,
  OrchestrationThreadActivity,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { foldSubagentActivities, type RuntimeSubagent } from "./subagentRuntime.ts";

const ImportedActivity = Schema.Struct({
  activityId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  tone: Schema.String,
  kind: Schema.String,
  summary: Schema.String,
  sequence: Schema.NullOr(Schema.Number),
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeImportedActivity = Schema.decodeUnknownOption(ImportedActivity);
const decodeActivity = Schema.decodeUnknownOption(OrchestrationThreadActivity);

/** Recover display history from retained migration records, never provider execution state. */
export function historicalSubagentsToRuntime(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  inherited: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = [],
): ReadonlyArray<RuntimeSubagent> {
  const activities: OrchestrationThreadActivity[] = [];
  const seen = new Set<string>();
  const collect = (item: OrchestrationV2TurnItem, sourceThreadId: string) => {
    if (
      item.type !== "dynamic_tool" ||
      item.runId !== null ||
      item.nodeId !== null ||
      item.nativeItemRef !== null
    )
      return;
    const decoded = decodeImportedActivity(item.input);
    if (Option.isNone(decoded)) return;
    const record = decoded.value;
    if (
      (item.inheritedFrom?.itemId ?? item.id) !==
        `migration:v1:history:activity:${record.activityId}` ||
      !record.kind.startsWith("task.")
    )
      return;
    const originThreadId = item.inheritedFrom?.threadId ?? sourceThreadId;
    const identity = `${originThreadId}:${record.activityId}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const prefix = `historical:${originThreadId}:`;
    const payload: Record<string, unknown> = {
      ...record.payload,
      agentKind:
        record.payload.agentKind ??
        classifyTaskAgentKind({
          taskType:
            typeof record.payload.taskType === "string" ? record.payload.taskType : undefined,
          agentId: typeof record.payload.agentId === "string" ? record.payload.agentId : undefined,
        }),
    };
    for (const key of ["taskId", "agentId", "parentAgentId"]) {
      if (typeof payload[key] === "string") payload[key] = `${prefix}${payload[key]}`;
    }
    const activity = decodeActivity({
      id: identity,
      turnId: record.turnId,
      tone: record.tone,
      kind: record.kind,
      summary: record.summary,
      payload,
      ...(record.sequence === null ? {} : { sequence: record.sequence }),
      createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
    });
    if (Option.isSome(activity)) activities.push(activity.value);
  };
  items.forEach((item) => collect(item, item.threadId));
  inherited.forEach((row) => collect(row.item, row.sourceThreadId));
  // Native runtime requests and completion wakes are intentionally absent.
  return foldSubagentActivities(activities, { sessionLive: false }).map((agent) => ({
    ...agent,
    historical: true,
  }));
}
