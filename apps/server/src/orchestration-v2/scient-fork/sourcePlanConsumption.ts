/** A native turn accepted for a run started from a proposed plan marks that plan
 * consumed, inside the same write transaction. */
import {
  EventId,
  OrchestrationV2RunJson,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type * as ProjectionStore from "../ProjectionStore.ts";
import { sourcePlanFingerprint } from "../SourcePlan.ts";

const decodeSourcePlanRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunJson),
);

/** Track plans within one batch of events. Called after each event is positioned; returns
 * a plan-consumed event when the event is an accepted turn of a plan-started run. */
export const makeSourcePlanConsumer = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
}) => {
  const { sql, projectionStore } = deps;
  const pendingPlans = new Map<
    string,
    Extract<OrchestrationV2DomainEvent, { type: "plan.updated" }>["payload"]
  >();
  return (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      if (event.type === "plan.updated") {
        pendingPlans.set(`${event.threadId}\u0000${event.payload.id}`, event.payload);
      }
      if (event.type !== "provider-turn.updated") return undefined;
      const turn = event.payload;
      if (
        turn.acceptedAt === undefined ||
        turn.nativeAcceptance !== "accepted" ||
        turn.runAttemptId === null ||
        turn.nativeTurnRef === null ||
        turn.startedAt === null ||
        turn.status === "pending"
      )
        return undefined;
      // Read only canonical committed owners, within the enclosing append transaction.
      // A callback for a child, replaced attempt, or pooled sibling cannot consume a plan.
      const rows = yield* sql<{ readonly payload_json: string }>`
      SELECT r.payload_json
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_run_attempts a
        ON a.attempt_id = ${turn.runAttemptId}
       AND a.run_id = r.run_id AND a.thread_id = r.thread_id
      JOIN orchestration_v2_projection_nodes n
        ON n.node_id = ${turn.nodeId} AND n.thread_id = r.thread_id
       AND n.run_id = r.run_id
      JOIN orchestration_v2_projection_provider_threads p
        ON p.provider_thread_id = ${turn.providerThreadId} AND p.thread_id = r.thread_id
      WHERE r.thread_id = ${event.threadId}
        AND r.status IN ('running', 'waiting')
        AND json_extract(r.payload_json, '$.activeAttemptId') = a.attempt_id
        AND json_extract(r.payload_json, '$.rootNodeId') = n.node_id
        AND json_extract(r.payload_json, '$.sourcePlanFingerprint') IS NOT NULL
        AND r.provider_thread_id = p.provider_thread_id
        AND r.provider_instance_id = p.provider_instance_id
        AND p.last_run_ordinal = r.ordinal
        AND a.provider_thread_id = p.provider_thread_id
        AND a.provider_instance_id = p.provider_instance_id
        AND p.driver = ${turn.nativeTurnRef.driver}
        AND (a.provider_turn_id IS NULL OR a.provider_turn_id = ${turn.id})
        AND json_extract(a.payload_json, '$.rootNodeId') = n.node_id
        AND n.kind = 'root_turn' AND n.parent_node_id IS NULL
        AND n.provider_thread_id = p.provider_thread_id
        AND (n.provider_turn_id IS NULL OR n.provider_turn_id = ${turn.id})
      LIMIT 1`;
      if (rows[0] === undefined) return undefined;
      const run = yield* decodeSourcePlanRun(rows[0].payload_json);
      if (
        (event.runId !== undefined && event.runId !== run.id) ||
        (event.nodeId !== undefined && event.nodeId !== run.rootNodeId) ||
        (event.providerInstanceId !== undefined &&
          event.providerInstanceId !== run.providerInstanceId) ||
        (event.driver !== undefined && event.driver !== turn.nativeTurnRef.driver)
      )
        return undefined;
      const ref = run.sourcePlanRef ?? run.legacyQueue?.sourceProposedPlan;
      if (ref === undefined) return undefined;
      const targetThread = yield* projectionStore.getThread(event.threadId);
      const sourceThread = yield* projectionStore.getThreadShell(ref.threadId);
      if (
        targetThread.deletedAt !== null ||
        targetThread.archivedAt !== null ||
        targetThread.activeProviderThreadId !== turn.providerThreadId ||
        sourceThread === null ||
        sourceThread.deletedAt !== null ||
        sourceThread.archivedAt !== null ||
        sourceThread.projectId !== targetThread.projectId
      )
        return undefined;
      const key = `${ref.threadId}\u0000${ref.planId}`;
      const plan =
        pendingPlans.get(key) ?? (yield* projectionStore.getPlan(ref.threadId, ref.planId));
      if (
        plan?.kind !== "proposed_plan" ||
        plan.id !== ref.planId ||
        plan.threadId !== ref.threadId ||
        plan.status !== "active" ||
        sourcePlanFingerprint(plan) !== run.sourcePlanFingerprint
      )
        return undefined;
      const consumed: Extract<OrchestrationV2DomainEvent, { type: "plan.updated" }> = {
        id: EventId.make(`${event.id}:source-plan-consumed`),
        type: "plan.updated",
        threadId: plan.threadId,
        ...(plan.runId === null ? {} : { runId: plan.runId }),
        nodeId: plan.nodeId,
        occurredAt: event.occurredAt,
        payload: {
          ...plan,
          status: "completed",
          consumedBy: {
            threadId: event.threadId,
            runId: run.id,
            runAttemptId: turn.runAttemptId,
            providerTurnId: turn.id,
          },
        },
      };
      pendingPlans.set(key, consumed.payload);
      return consumed;
    });
};
