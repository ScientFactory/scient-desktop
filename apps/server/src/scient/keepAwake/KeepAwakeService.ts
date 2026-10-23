import {
  KeepAwakeWorkBatch,
  OrchestrationV2ProviderThread,
  type KeepAwakeObserveRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { EventStoreV2 } from "../../orchestration-v2/EventStore.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { OrchestrationEffectWorkerV2 } from "../../orchestration-v2/EffectWorker.ts";
import { ServerEnvironmentIdentity } from "../../environment/ServerEnvironment.ts";
import { assembleGroups, type WorkFacts } from "./work.ts";

export class KeepAwakeObservationError extends Schema.TaggedError<KeepAwakeObservationError>()(
  "KeepAwakeObservationError",
  { cause: Schema.Defect() },
) {}
const decodeBlockedChildren = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
export class KeepAwakeService extends Context.Service<
  KeepAwakeService,
  {
    readonly observe: (
      request: KeepAwakeObserveRequest,
    ) => Effect.Effect<KeepAwakeWorkBatch, KeepAwakeObservationError>;
  }
>()("t3/scient/keepAwake/KeepAwakeService") {}

export const layer = Layer.effect(
  KeepAwakeService,
  Effect.gen(function* () {
    const store = yield* ProjectionStoreV2;
    const events = yield* EventStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* ProviderSessionManagerV2;
    const worker = yield* OrchestrationEffectWorkerV2;
    const environment = yield* ServerEnvironmentIdentity;
    const decodeProvider = Schema.decodeUnknownEffect(
      Schema.fromJsonString(OrchestrationV2ProviderThread),
    );
    const lock = yield* Semaphore.make(1);
    const load = sql.withTransaction(
      Effect.gen(function* () {
        const snapshot = yield* store.getShellSnapshot();
        const runs = yield* sql<{
          thread_id: ThreadId;
          ordinal: number;
          status: string;
          held: number;
          position: number;
          provider_json: string | null;
        }>`
        SELECT r.thread_id, r.ordinal, r.status, COALESCE(json_extract(r.payload_json, '$.queueHeld'), 0) AS held,
          COALESCE(json_extract(r.payload_json, '$.queuePosition'), r.ordinal) AS position,
          p.payload_json AS provider_json
        FROM orchestration_v2_projection_runs r
        LEFT JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = r.provider_thread_id
        WHERE r.status IN ('preparing', 'starting', 'running', 'waiting', 'queued')
      `;
        const metadata = yield* sql<{
          thread_id: ThreadId;
          native_running: number;
          blocking_input: number;
          blocked_children: string;
          finalizing: number;
          progress: number;
        }>`
        SELECT t.thread_id,
          COALESCE((SELECT json_group_array(DISTINCT s.child_thread_id)
            FROM orchestration_v2_projection_runtime_requests r
            JOIN orchestration_v2_projection_nodes n ON n.node_id = r.node_id
            JOIN orchestration_v2_projection_subagents s ON s.subagent_id = n.parent_node_id
            WHERE r.thread_id = t.thread_id AND r.status = 'pending' AND r.kind <> 'dynamic_tool_call'
              AND s.child_thread_id IS NOT NULL), '[]') AS blocked_children,
          (EXISTS(SELECT 1 FROM orchestration_v2_projection_runtime_requests r WHERE r.thread_id = t.thread_id
            AND r.status = 'pending' AND r.kind <> 'dynamic_tool_call') OR
           EXISTS(SELECT 1 FROM orchestration_v2_projection_turn_items i JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
            WHERE i.thread_id = t.thread_id AND i.type = 'secret_request' AND i.status = 'waiting'
              AND r.status IN ('preparing', 'starting', 'running', 'waiting'))) AS blocking_input,
          EXISTS(SELECT 1 FROM orchestration_v2_projection_nodes n WHERE n.thread_id = t.thread_id
            AND n.kind = 'root_turn' AND n.run_id IS NULL AND n.status IN ('pending', 'running', 'waiting')) AS native_running,
          EXISTS(SELECT 1 FROM orchestration_v2_effect_outbox o WHERE o.thread_id = t.thread_id
            AND o.effect_type = 'checkpoint.capture' AND o.status IN ('pending', 'running')) AS finalizing,
          COALESCE((SELECT MAX(e.sequence) FROM orchestration_events e WHERE e.stream_id = t.thread_id
            AND e.aggregate_kind = 'thread' AND e.application_event_version = 2
            AND e.event_type IN ('run.created', 'run.updated', 'run-attempt.created', 'run-attempt.updated',
              'node.updated', 'turn-item.updated', 'message.updated', 'provider-turn.updated', 'subagent.updated')), 0) AS progress
        FROM orchestration_v2_projection_threads t
      `;
        return [snapshot, runs, metadata] as const;
      }),
    );
    let cached: { revision: string; value: Effect.Success<typeof load> } | undefined;
    return KeepAwakeService.of({
      observe: Effect.fn("KeepAwakeService.observe")((request: KeepAwakeObserveRequest) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const sequence = yield* events.latestApplicationSequence;
            const revisions = yield* sql<{ revision: string }>`
      SELECT CAST(${sequence} AS TEXT) || ':' ||
        COALESCE((SELECT GROUP_CONCAT(effect_id || status || updated_at) FROM orchestration_v2_effect_outbox
          WHERE effect_type = 'checkpoint.capture' AND status IN ('pending', 'running')), '') AS revision
    `;
            const revision = revisions[0]!.revision;
            const value = cached?.revision === revision ? cached.value : yield* load;
            cached = { revision, value };
            const [snapshot, runs, metadata] = value;
            const shells = [...snapshot.threads];
            // Resolve referenced children directly, including terminal/archived children omitted by the active shell.
            const known = new Set(shells.map((shell) => shell.id));
            for (let index = 0; index < shells.length; index++) {
              for (const task of shells[index]!.pendingBackgroundTasks ?? []) {
                if (
                  task.kind !== "subagent" ||
                  task.childThreadId === undefined ||
                  known.has(task.childThreadId)
                )
                  continue;
                known.add(task.childThreadId);
                const child = yield* store.getThreadShell(task.childThreadId);
                if (child !== null) shells.push(child);
              }
            }
            for (const id of request.threadIds)
              if (!known.has(id)) {
                known.add(id);
                const shell = yield* store.getThreadShell(id);
                if (shell !== null) shells.push(shell);
              }
            const meta = new Map(metadata.map((row) => [row.thread_id, row]));
            const byThread = new Map<ThreadId, (typeof runs)[number][]>();
            for (const run of runs)
              byThread.set(run.thread_id, [...(byThread.get(run.thread_id) ?? []), run]);
            const facts: WorkFacts[] = shells.map((shell) => {
              const work = byThread.get(shell.id) ?? [];
              const row = meta.get(shell.id);
              const head = work
                .filter((run) => run.status === "queued")
                .sort((a, b) => a.position - b.position || a.ordinal - b.ordinal)[0];
              return {
                shell,
                blockingInput: !!row?.blocking_input,
                blockedChildren: decodeBlockedChildren(row?.blocked_children ?? "[]"),
                active: work.some((run) => run.status !== "queued"),
                queued: work.some((run) => run.status === "queued"),
                runnableQueue: head !== undefined && !head.held,
                nativeRunning: !!row?.native_running,
                finalizing: !!row?.finalizing,
                progress: String(row?.progress ?? 0),
              };
            });
            const groups = assembleGroups(
              facts,
              new Set(request.threadIds),
              request.includeLocalWork,
            );
            const inspected = new Map<ThreadId, "connected" | "unowned" | "unknown">();
            for (const group of groups)
              for (const member of group.members) {
                if (!member.runnable || inspected.has(member.threadId)) continue;
                let ownership: "connected" | "unowned" | "unknown" = "unowned";
                if (yield* worker.isExecutingThread(member.threadId)) ownership = "connected";
                else
                  for (const run of byThread.get(member.threadId) ?? []) {
                    if (run.status === "queued" || run.provider_json === null) continue;
                    const providerThread = yield* decodeProvider(run.provider_json);
                    const status = yield* sessions.inspectExecution({
                      threadId: member.threadId,
                      providerThread,
                      runOrdinal: run.ordinal,
                    });
                    if (status === "connected") {
                      ownership = status;
                      break;
                    }
                    if (status === "unknown") ownership = status;
                  }
                // A provider-owned background task may outlive its transport. Do not invent a failure.
                if (
                  !(byThread.get(member.threadId) ?? []).some((run) => run.status !== "queued") &&
                  !member.finalizing
                ) {
                  const fact = facts.find((entry) => entry.shell.id === member.threadId)!;
                  if (!fact.runnableQueue) ownership = "unknown";
                }
                inspected.set(member.threadId, ownership);
              }
            const environmentId = yield* environment.getEnvironmentId;
            const result = groups.map((group) => ({
              ...group,
              members: group.members.map((member) => ({
                ...member,
                ownership: inspected.get(member.threadId) ?? member.ownership,
              })),
            }));
            for (const id of request.threadIds)
              if (!shells.some((shell) => shell.id === id))
                result.push({
                  threadId: id,
                  members: [
                    {
                      threadId: id,
                      title: "Thread",
                      latestRunId: null,
                      removed: true,
                      unfinished: false,
                      runnable: false,
                      blockingInput: false,
                      finalizing: false,
                      ownership: "unowned",
                      progress: "removed",
                      reason: "Thread removed",
                    },
                  ],
                });
            return { environmentId, groups: result };
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError((cause) => new KeepAwakeObservationError({ cause })),
          ),
        ),
      ),
    });
  }),
);
