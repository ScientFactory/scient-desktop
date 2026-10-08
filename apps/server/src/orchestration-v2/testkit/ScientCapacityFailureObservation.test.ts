// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  RunId,
  MessageId,
  ProviderSessionId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as EventStore from "../EventStore.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import { ScientCapacityFailureObservation } from "./ScientCapacityFailureObservation.test-support.ts";

const threadId = ThreadId.make("capacity-race:sql-failure");
// Only the forwarding observer's selected header is under test; no canonical receipt is seeded.
const occurredAt = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
  {
    id: EventId.make("diagnostic"),
    type: "provider-session.detached",
    threadId,
    occurredAt,
    payload: { providerSessionId: ProviderSessionId.make("synthetic"), detachedAt: occurredAt },
  },
];
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const errorEvent = (failure: OrchestrationV2ProviderFailure) =>
  ({
    id: EventId.make("diagnostic-error"),
    type: "turn-item.updated",
    threadId,
    occurredAt,
    payload: {
      id: TurnItemId.make("diagnostic-error-item"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "failed",
      title: "Provider error",
      startedAt: occurredAt,
      completedAt: occurredAt,
      updatedAt: occurredAt,
      type: "error",
      failure,
    },
  }) satisfies Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>;

it.effect(
  "retains requested typed error detail after committed and declined successful writes",
  () =>
    Effect.gen(function* () {
      const failure = {
        class: "transport_error",
        message: "The provider event stream closed unexpectedly.",
        code: "ERR_STREAM_CLOSED",
        retryable: true,
        resetAt: null,
      } satisfies OrchestrationV2ProviderFailure;
      for (const committed of [true, false]) {
        let snapshot: unknown;
        let published = 0;
        const observation = new ScientCapacityFailureObservation("/missing/db", (value) => {
          snapshot = value;
          published++;
        });
        observation.at("race.accepted", threadId);
        const writeResult = { committed };
        assert.strictEqual(
          yield* observation.forward(
            "writeIfRunCurrent",
            [errorEvent(failure)],
            Effect.succeed(writeResult),
          ),
          writeResult,
        );
        assert.equal(published, 0);
        const originalCause = Cause.fail("original acceptance wait failed");
        const result = yield* observation
          .beforeCleanup(Effect.failCause(originalCause), Effect.succeed(null))
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.strictEqual(result.cause, originalCause);
        assert.equal(published, 1);
        const text = encodeJson(snapshot);
        assert.include(text, '"exit":"Success"');
        assert.include(text, `"committed":${committed}`);
        assert.include(text, '"requested":[{"id":"diagnostic-error"');
        assert.include(text, encodeJson(failure));
        assert.include(text, "original acceptance wait failed");
      }
    }),
);

it.effect("selects only capacity-race error failures and redacts common credential forms", () =>
  Effect.gen(function* () {
    let snapshot: unknown;
    const observation = new ScientCapacityFailureObservation("/missing/db", (value) => {
      snapshot = value;
    });
    const failure = {
      class: "transport_error",
      message: "Stream closed; Bearer secret-token; api_key=credential-canary",
      code: "ERR_STREAM_CLOSED",
      retryable: null,
      prompt: "failure-prompt-canary",
      parameters: ["sql-parameter-canary"],
      files: ["/private/file-canary"],
    } satisfies OrchestrationV2ProviderFailure & {
      readonly prompt: string;
      readonly parameters: ReadonlyArray<string>;
      readonly files: ReadonlyArray<string>;
    };
    const selected = errorEvent(failure);
    const foreignThreadId = ThreadId.make("unrelated-thread");
    const foreign = errorEvent({ ...failure, message: "foreign-error-canary" });
    const mismatched = errorEvent({ ...failure, message: "mismatched-error-canary" });
    const prompt: OrchestrationV2DomainEvent = {
      ...selected,
      id: EventId.make("diagnostic-prompt"),
      payload: {
        ...selected.payload,
        type: "assistant_message",
        messageId: MessageId.make("diagnostic-prompt-message"),
        text: "assistant-content-canary",
        streaming: false,
      },
    };
    yield* observation.forward(
      "writeWithEffects",
      [
        { ...selected, payload: { ...selected.payload, title: "title-content-canary" } },
        {
          ...foreign,
          threadId: foreignThreadId,
          payload: { ...foreign.payload, threadId: foreignThreadId },
        },
        { ...mismatched, payload: { ...mismatched.payload, threadId: foreignThreadId } },
        prompt,
      ],
      Effect.void,
    );
    yield* observation
      .beforeCleanup(Effect.fail("original wait failed"), Effect.succeed(null))
      .pipe(Effect.exit);
    const text = encodeJson(snapshot);
    assert.include(text, "Stream closed; Bearer [REDACTED]; api_key=[REDACTED]");
    assert.include(text, "ERR_STREAM_CLOSED");
    for (const excluded of [
      "secret-token",
      "credential-canary",
      "failure-prompt-canary",
      "sql-parameter-canary",
      "file-canary",
      "foreign-error-canary",
      "mismatched-error-canary",
      "assistant-content-canary",
      "title-content-canary",
    ])
      assert.notInclude(text, excluded);
    const unrelated = Effect.succeed({ committed: true });
    assert.strictEqual(
      observation.forward(
        "unrelated",
        [
          {
            ...foreign,
            threadId: foreignThreadId,
            payload: { ...foreign.payload, threadId: foreignThreadId },
          },
        ],
        unrelated,
      ),
      unrelated,
    );
  }),
);

it.effect(
  "bounds typed failure text and reports invalid failure detail without changing the Cause",
  () =>
    Effect.gen(function* () {
      for (const message of ["a".repeat(4_096), "invalid".repeat(1_000)]) {
        let snapshot: unknown;
        const observation = new ScientCapacityFailureObservation("/missing/db", (value) => {
          snapshot = value;
        });
        const cause = Cause.fail({ code: "ORIGINAL_WRITE_FAILURE" });
        const result = yield* observation
          .beforeCleanup(
            observation.forward(
              "writeIfRunCurrent",
              [errorEvent({ class: "unknown", message, code: null, retryable: null })],
              Effect.failCause(cause),
            ),
            Effect.succeed(null),
          )
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.strictEqual(result.cause, cause);
        const text = encodeJson(snapshot);
        assert.include(text, "ORIGINAL_WRITE_FAILURE");
        if (message.length === 4_096) {
          assert.include(text, `"message":"${"a".repeat(4_000)}"`);
          assert.notInclude(text, "a".repeat(4_001));
        } else {
          assert.include(text, "Invalid typed provider failure");
          assert.notInclude(text, "invalidinvalid");
        }
      }
    }),
);

it.effect("forwards successes and declines unchanged without capturing or publishing", () =>
  Effect.gen(function* () {
    let published = 0,
      captured = 0;
    const observation = new ScientCapacityFailureObservation(
      "/missing/never-opened",
      () => published++,
    );
    const live = Effect.sync(() => captured++);
    for (const committed of [false, true]) {
      const result = { committed };
      assert.strictEqual(
        yield* observation.beforeCleanup(
          observation.forward("writeIfRunCurrent", events, Effect.succeed(result)),
          live,
        ),
        result,
      );
    }
    const unrelated = Effect.succeed(1);
    assert.strictEqual(observation.forward("unrelated", [], unrelated), unrelated);
    assert.equal(published, 0);
    assert.equal(captured, 0);
  }),
);

it.effect(
  "preserves nested failure Cause and captures once before the enclosing resource closes",
  () =>
    Effect.gen(function* () {
      const cause = Cause.fail({
        cause: {
          code: "ERR_SQLITE_ERROR",
          errcode: 1811,
          message: "synthetic capacity write failure",
          parameters: ["private prompt"],
          prompt: "private prompt",
        },
      });
      let open = false,
        published = 0;
      let snapshot: unknown;
      const observation = new ScientCapacityFailureObservation(
        "/missing/diagnostic-db",
        (value) => {
          assert.isTrue(open);
          snapshot = value;
          published++;
        },
      );
      observation.at("sql.run.failed", threadId);
      for (let index = 0; index < 35; index++) {
        yield* observation.forward("writeWithEffects", events, Effect.void);
      }
      const failed = observation.forward("writeIfRunCurrent", events, Effect.failCause(cause));
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              open = true;
            }),
            () =>
              Effect.sync(() => {
                open = false;
              }),
          );
          return yield* observation
            .beforeCleanup(
              observation.beforeCleanup(
                failed,
                Effect.sync(() => {
                  assert.isTrue(open);
                  return { present: true };
                }),
              ),
              Effect.die("second capture must not run"),
            )
            .pipe(Effect.exit);
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.strictEqual(result.cause, cause);
      assert.equal(published, 1);
      assert.isFalse(open);
      assert.include(encodeJson(snapshot), "sql.run.failed");
      assert.include(encodeJson(snapshot), "1811");
      assert.notInclude(encodeJson(snapshot), "private prompt");
      assert.include(encodeJson(snapshot), '"ordinal":36');
      assert.include(encodeJson(snapshot), '"droppedWrites":4');
      assert.include(encodeJson(snapshot), "writeIfRunCurrent");
      assert.include(encodeJson(snapshot), "unavailable");
    }),
);

it.effect(
  "observer defects and failed live reads cannot replace typed failure or defect Causes",
  () =>
    Effect.gen(function* () {
      for (const cause of [Cause.fail("original failure"), Cause.die("original defect")]) {
        const observation = new ScientCapacityFailureObservation("/missing/db", () => {
          throw new Error("output refused");
        });
        const result = yield* observation
          .beforeCleanup(Effect.failCause(cause), Effect.die("live read unavailable"))
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) assert.strictEqual(result.cause, cause);
      }
    }),
);

it.effect("preserves interruption while the once-only failure callback runs", () =>
  Effect.gen(function* () {
    let published = 0;
    const observation = new ScientCapacityFailureObservation("/missing/db", () => published++);
    const result = yield* observation
      .beforeCleanup(Effect.interrupt, Effect.succeed(null))
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
    assert.equal(published, 1);
  }),
);

it.live("bounds an unavailable live-owner read and retains the original failure", () =>
  Effect.gen(function* () {
    let snapshot: unknown;
    const cause = Cause.fail("original wait failed");
    const observation = new ScientCapacityFailureObservation("/missing/db", (value) => {
      snapshot = value;
    });
    const result = yield* observation
      .beforeCleanup(Effect.failCause(cause), Effect.never)
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) assert.strictEqual(result.cause, cause);
    assert.include(encodeJson(snapshot), "TimeoutError");
  }),
);

it.effect(
  "reads canonical state and outbox without modifying the database; missing tables stay explicit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "capacity-observer-")),
          ),
          (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true })),
        );
        const file = NodePath.join(root, "state.sqlite");
        const db = new NodeSqlite.DatabaseSync(file);
        db.exec(`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, status TEXT, payload_json TEXT);
      CREATE TABLE orchestration_v2_effect_outbox (effect_id TEXT, command_id TEXT, thread_id TEXT, effect_type TEXT, status TEXT, attempt_count INTEGER, lease_owner TEXT, lease_expires_at TEXT, completed_at TEXT, last_error TEXT);
      CREATE TABLE scient_model_context_windows (model_selection_json TEXT, max_tokens INTEGER);`);
        db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?)").run(
          "run:synthetic",
          threadId,
          "running",
          '{"activeAttemptId":"attempt:synthetic"}',
        );
        db.prepare(
          "INSERT INTO orchestration_v2_effect_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          "effect:synthetic",
          `send:${threadId}`,
          threadId,
          "provider-turn.start",
          "running",
          1,
          "worker:synthetic",
          null,
          null,
          null,
        );
        db.close();
        const before = NodeFS.readFileSync(file);
        let snapshot: unknown;
        const observation = new ScientCapacityFailureObservation(file, (value) => {
          snapshot = value;
        });
        observation.at("sql.run.failed", threadId);
        yield* observation
          .beforeCleanup(Effect.fail("original timeout"), Effect.succeed({ present: true }))
          .pipe(Effect.exit);
        assert.deepEqual(NodeFS.readFileSync(file), before);
        const text = encodeJson(snapshot);
        assert.include(text, "attempt:synthetic");
        assert.include(text, "provider-turn.start");
        assert.include(text, "running");
        assert.include(text, "worker:synthetic");
        assert.include(text, "unavailable");
      }),
    ),
);

const decodeCanonicalSqlObservation = Schema.decodeUnknownEffect(
  Schema.Struct({
    sql: Schema.Struct({
      events: Schema.Array(Schema.Unknown),
      receipts: Schema.Array(Schema.Unknown),
    }),
  }),
);

it.effect(
  "reads migrated canonical store events and receipts, excluding legacy and foreign rows",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "capacity-canonical-")),
          ),
          (path) => Effect.sync(() => NodeFS.rmSync(path, { recursive: true })),
        );
        const file = NodePath.join(root, "state.sqlite");
        const stores = Layer.mergeAll(EventStore.layer, CommandReceiptStore.layer).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: file })),
        );
        yield* Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const eventStore = yield* EventStore.EventStoreV2;
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          const commandId = CommandId.make("capacity:canonical-command");
          const runId = RunId.make("capacity:canonical-run");
          const nodeId = NodeId.make("capacity:canonical-node");
          const failure = {
            class: "transport_error",
            message: "Canonical typed stream failure",
            code: "ERR_STREAM_CLOSED",
            retryable: true,
          } satisfies OrchestrationV2ProviderFailure;
          const canonicalEvent = {
            ...errorEvent(failure),
            runId,
            nodeId,
            payload: { ...errorEvent(failure).payload, runId, nodeId },
          };
          const [stored] = yield* eventStore.append({ commandId, events: [canonicalEvent] });
          assert.ok(stored);
          const foreignThread = ThreadId.make("foreign-capacity-thread");
          yield* eventStore.append({
            events: [{ ...events[0]!, id: EventId.make("foreign-event"), threadId: foreignThread }],
          });
          // Negative controls use the actual migrated table, not a duplicated schema.
          // Copy the producer-encoded row, changing only its version or aggregate identity.
          for (const [id, kind, version] of [
            ["legacy-version", "thread", 1],
            ["unknown-version", "thread", 3],
            ["project-aggregate", "project", 2],
          ] as const) {
            yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json, application_event_version
            )
            SELECT ${id}, ${kind}, stream_id, ${version} + 10, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json, ${version}
            FROM orchestration_events WHERE event_id = ${canonicalEvent.id}
          `;
          }
          const receipt = {
            commandId,
            threadId,
            commandType: "thread.send",
            acceptedAt: occurredAt,
            resultSequence: stored.sequence,
            status: "accepted",
            error: null,
          } satisfies CommandReceiptStore.CommandReceiptV2;
          yield* receipts.upsert(receipt);
          yield* receipts.upsert({
            ...receipt,
            commandId: CommandId.make("foreign-thread-receipt"),
            threadId: foreignThread,
          });
          yield* receipts.upsert({
            commandId: CommandId.make("project-receipt"),
            projectId: ProjectId.make(threadId),
            commandType: "project.update",
            acceptedAt: occurredAt,
            resultSequence: stored.sequence,
            status: "accepted",
            error: null,
          });
          // The retired V2 tables still exist for migration; their rows are not current truth.
          yield* sql`
          INSERT INTO orchestration_v2_events (
            event_id, thread_id, run_id, node_id, event_type, occurred_at, payload_json
          ) SELECT 'legacy-table-event', stream_id, NULL, NULL, event_type, occurred_at,
            payload_json FROM orchestration_events WHERE event_id = ${canonicalEvent.id}
        `;
          yield* sql`
          INSERT INTO orchestration_v2_command_receipts (
            command_id, thread_id, command_type, accepted_at, result_sequence, status, error
          ) SELECT 'legacy-table-receipt', aggregate_id, command_type, accepted_at,
            result_sequence, status, error FROM orchestration_command_receipts
            WHERE command_id = ${commandId}
        `;
          const before = NodeFS.readFileSync(file);
          let snapshot: unknown;
          const observation = new ScientCapacityFailureObservation(file, (value) => {
            snapshot = value;
          });
          observation.at("canonical-reader", threadId);
          const cause = Cause.fail("original native wait failure");
          const result = yield* observation
            .beforeCleanup(Effect.failCause(cause), Effect.succeed(null))
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          if (Exit.isFailure(result)) assert.strictEqual(result.cause, cause);
          assert.deepEqual(NodeFS.readFileSync(file), before);
          const observed = yield* decodeCanonicalSqlObservation(snapshot);
          assert.deepEqual(observed.sql.events, [
            {
              sequence: stored.sequence,
              event_type: "turn-item.updated",
              run_id: runId,
              node_id: nodeId,
              status: "failed",
              provider_turn_id: null,
              max_tokens: null,
              error_message: failure.message,
            },
          ]);
          assert.deepEqual(observed.sql.receipts, [
            {
              command_id: commandId,
              command_type: "thread.send",
              status: "accepted",
              result_sequence: stored.sequence,
              error: null,
            },
          ]);
        }).pipe(Effect.provide(stores));
      }),
    ),
);
