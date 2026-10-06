// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
import {
  OrchestrationV2ProviderFailure,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFailure = Schema.decodeUnknownSync(OrchestrationV2ProviderFailure);

// Only the transport-safe typed failure is selected, never arbitrary item/request content.
// Reuse the producer's common credential redaction; it is not universal text/path sanitization.
const requestedFailureDetail = (value: OrchestrationV2ProviderFailure) => {
  try {
    const failure = decodeFailure(value);
    const redacted = makeProviderFailure({
      class: failure.class,
      message: failure.message,
      code: failure.code,
      retryable: failure.retryable,
      ...(failure.resetAt === undefined ? {} : { resetAt: failure.resetAt }),
    });
    return {
      class: failure.class,
      message: redacted.message.slice(0, 4_000),
      code: redacted.code,
      retryable: failure.retryable,
      ...(failure.resetAt === undefined ? {} : { resetAt: failure.resetAt }),
    };
  } catch {
    return { unavailable: "Invalid typed provider failure" };
  }
};

// Keep nested SQL error codes/causes without serializing request objects or SQL parameters.
const scalarError = (value: unknown, depth = 0): unknown => {
  if (depth === 8) return "[depth limit]";
  if (typeof value === "string") return value.slice(0, 4_000);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((entry) => scalarError(entry, depth + 1));
  const fields: Record<string, unknown> = {};
  for (const key of [
    "_tag",
    "reasons",
    "cause",
    "error",
    "defect",
    "name",
    "message",
    "code",
    "errno",
    "errcode",
    "errstr",
  ]) {
    if (key in value) fields[key] = scalarError(Reflect.get(value, key), depth + 1);
  }
  return fields;
};
const describe = (value: unknown) =>
  NodeUtil.inspect(scalarError(value), { depth: null, maxArrayLength: 16, maxStringLength: 4_000 });

/** Test-only, bounded observations. SQL and output happen only on original failure. */
export class ScientCapacityFailureObservation {
  private phase = "serve.body";
  private threadId: string | undefined;
  private captured = false;
  private readonly writes: Array<Readonly<Record<string, unknown>>> = [];
  private droppedWrites = 0;

  private readonly databaseFile: string;
  private readonly publish: (snapshot: unknown) => void;

  constructor(
    databaseFile: string,
    publish: (snapshot: unknown) => void = (snapshot) => {
      const text = encodeJson(snapshot) + "\n";
      const destination = process.env.T3_CAPACITY_DIAGNOSTIC_OUTPUT;
      if (destination === undefined) NodeFS.writeSync(2, text);
      else NodeFS.writeFileSync(destination, text, { flag: "wx" });
    },
  ) {
    this.databaseFile = databaseFile;
    this.publish = publish;
  }

  at(phase: string, threadId?: string) {
    this.phase = phase;
    this.threadId = threadId;
  }

  liveOwners(
    peers: ReadonlyArray<{
      readonly appThreadId: ThreadId;
      readonly nativeId: string;
      readonly turnId: string;
      readonly offered: ReadonlyArray<string>;
      readonly started: Deferred.Deferred<void>;
      readonly closed: Deferred.Deferred<void>;
    }>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const orchestrator = yield* OrchestratorV2;
      const manager = yield* ProviderSessionManagerV2;
      return yield* Effect.forEach(
        peers
          .filter((peer) => this.threadId === undefined || peer.appThreadId === this.threadId)
          .slice(0, 16),
        (peer) =>
          Effect.gen(function* () {
            const projection = yield* orchestrator.getThreadProjection(peer.appThreadId);
            const owners = yield* Effect.forEach(
              projection.providerThreads.slice(0, 32),
              (thread) =>
                Effect.gen(function* () {
                  if (thread.providerSessionId === null)
                    return {
                      providerThreadId: thread.id,
                      providerSessionId: null,
                      activeMembership: "unavailable: no projected session",
                    };
                  // Manager.get touches activity: never use it in a diagnostic read.
                  const closing =
                    manager.getCloseState === undefined
                      ? Option.none()
                      : yield* manager.getCloseState(thread.providerSessionId);
                  return {
                    providerThreadId: thread.id,
                    providerSessionId: thread.providerSessionId,
                    activeMembership: "unavailable: lookup would refresh activity",
                    closeState:
                      manager.getCloseState === undefined
                        ? { unavailable: "close-state lookup not provided" }
                        : Option.isSome(closing)
                          ? closing.value
                          : null,
                  };
                }),
            );
            return {
              threadId: peer.appThreadId,
              nativeId: peer.nativeId,
              nativeTurnId: peer.turnId,
              offeredCount: peer.offered.length,
              started: yield* Deferred.isDone(peer.started),
              closed: yield* Deferred.isDone(peer.closed),
              runs: projection.runs.slice(0, 32).map((run) => ({
                id: run.id,
                status: run.status,
                activeAttemptId: run.activeAttemptId,
              })),
              owners,
            };
          }),
      );
    });
  }

  forward<A, E, R>(
    operation: string,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> {
    if (!events.some((event) => event.threadId?.startsWith("capacity-race:"))) return effect;
    return effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          // An observer defect must never turn a successful write into a failed write.
          try {
            if (this.writes.length === 32) {
              this.writes.shift();
              this.droppedWrites++;
            }
            this.writes.push({
              ordinal: this.droppedWrites + this.writes.length + 1,
              operation,
              exit: exit._tag,
              ...(Exit.isFailure(exit)
                ? { cause: describe(exit.cause) }
                : {
                    committed:
                      Predicate.isObject(exit.value) && "committed" in exit.value
                        ? exit.value.committed
                        : undefined,
                  }),
              requested: events.slice(0, 16).map((event) => ({
                id: event.id,
                type: event.type,
                threadId: event.threadId,
                ...(event.type === "run.updated"
                  ? { runId: event.payload.id, status: event.payload.status }
                  : {}),
                ...(event.type === "provider-turn.updated"
                  ? { providerTurnId: event.payload.id, status: event.payload.status }
                  : {}),
                ...(event.threadId?.startsWith("capacity-race:") &&
                event.type === "turn-item.updated" &&
                event.payload.type === "error" &&
                event.payload.threadId === event.threadId
                  ? { failure: requestedFailureDetail(event.payload.failure) }
                  : {}),
              })),
            });
          } catch {
            this.droppedWrites++;
          }
        }),
      ),
    );
  }

  beforeCleanup<A, E, R, E2, R2>(
    effect: Effect.Effect<A, E, R>,
    liveOwners: Effect.Effect<unknown, E2, R2>,
  ): Effect.Effect<A, E, R | R2> {
    return effect.pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || this.captured) return Effect.void;
        this.captured = true;
        return Effect.gen({ self: this }, function* () {
          const owners = yield* liveOwners.pipe(Effect.timeout("100 millis"), Effect.exit);
          yield* Effect.sync(() => {
            try {
              this.publish({
                phase: this.phase,
                threadId: this.threadId,
                originalCause: describe(exit.cause),
                writes: this.writes,
                droppedWrites: this.droppedWrites,
                liveOwners: Exit.isSuccess(owners)
                  ? owners.value
                  : { unavailable: describe(owners.cause) },
                sql: this.readSql(),
              });
            } catch (error) {
              // Best-effort diagnostic output cannot mask the original Cause.
              try {
                NodeFS.writeSync(
                  2,
                  `Capacity failure observation unavailable: ${describe(error)}\n`,
                );
              } catch {}
            }
          });
        });
      }),
    );
  }

  private readSql() {
    let reader: NodeSqlite.DatabaseSync | undefined;
    const rows: Record<string, unknown> = {};
    const thread = this.threadId ?? "capacity-%";
    try {
      reader = new NodeSqlite.DatabaseSync(this.databaseFile, { readOnly: true, timeout: 0 });
      const queries = {
        runs: "SELECT run_id, thread_id, status, json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id FROM orchestration_v2_projection_runs WHERE thread_id LIKE ? LIMIT 32",
        attempts:
          "SELECT attempt_id, run_id, root_node_id, provider_thread_id, provider_turn_id, status FROM orchestration_v2_projection_run_attempts WHERE thread_id LIKE ? LIMIT 32",
        nodes:
          "SELECT node_id, run_id, provider_thread_id, provider_turn_id, status FROM orchestration_v2_projection_nodes WHERE thread_id LIKE ? LIMIT 32",
        turns:
          "SELECT provider_turn_id, provider_thread_id, node_id, run_attempt_id, status, json_extract(payload_json, '$.nativeAcceptance') AS native_acceptance, json_extract(payload_json, '$.acceptedAt') AS accepted_at, json_extract(payload_json, '$.nativeTurnRef.nativeId') AS native_id, json_extract(payload_json, '$.tokenUsage.maxTokens') AS max_tokens FROM orchestration_v2_projection_provider_turns WHERE thread_id LIKE ? LIMIT 32",
        providerThreads:
          "SELECT provider_thread_id, status, json_extract(payload_json, '$.providerSessionId') AS provider_session_id, json_extract(payload_json, '$.lastRunOrdinal') AS last_run_ordinal FROM orchestration_v2_projection_provider_threads WHERE thread_id LIKE ? LIMIT 32",
        sessions:
          "SELECT provider_session_id, status FROM orchestration_v2_projection_provider_sessions WHERE thread_id LIKE ? LIMIT 32",
        events:
          "SELECT sequence, event_type, run_id, node_id, json_extract(payload_json, '$.status') AS status, json_extract(payload_json, '$.providerTurnId') AS provider_turn_id, json_extract(payload_json, '$.tokenUsage.maxTokens') AS max_tokens, CASE WHEN event_type = 'turn-item.updated' AND json_extract(payload_json, '$.type') = 'error' THEN json_extract(payload_json, '$.message') END AS error_message FROM orchestration_v2_events WHERE thread_id LIKE ? ORDER BY sequence DESC LIMIT 32",
        receipts:
          "SELECT command_id, command_type, status, result_sequence, error FROM orchestration_v2_command_receipts WHERE thread_id LIKE ? LIMIT 32",
        outbox:
          "SELECT effect_id, command_id, effect_type, status, attempt_count, lease_owner, lease_expires_at, completed_at, last_error FROM orchestration_v2_effect_outbox WHERE thread_id LIKE ? LIMIT 32",
      };
      for (const [name, query] of Object.entries(queries)) {
        try {
          rows[name] = reader.prepare(query).all(thread);
        } catch (error) {
          rows[name] = { unavailable: describe(error) };
        }
      }
      try {
        rows.capacity = reader
          .prepare(
            "SELECT model_selection_json, max_tokens FROM scient_model_context_windows WHERE max_tokens IN (22000, 42000) LIMIT 32",
          )
          .all();
      } catch (error) {
        rows.capacity = { unavailable: describe(error) };
      }
    } catch (error) {
      rows.unavailable = describe(error);
    } finally {
      try {
        reader?.close();
      } catch (error) {
        rows.closeUnavailable = describe(error);
      }
    }
    return rows;
  }
}
