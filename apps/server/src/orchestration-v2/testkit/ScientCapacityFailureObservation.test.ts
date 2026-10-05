// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
