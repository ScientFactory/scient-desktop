// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerFromPath as makeSqlitePersistenceLive } from "../../persistence/Sqlite.ts";
import { CommandReceiptV2 } from "../CommandReceiptStore.ts";
import { OrchestratorDispatchError } from "../Orchestrator.ts";
import type {
  ProviderAdapterV2InitiatedWorkIdentity,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { binary, json, layer } from "./PiNativeTestHarness.ts";
import {
  runNativeInitiatedWorkScenario,
  type PiNativeGenerationAdmissionProbe,
} from "./PiNativeInitiatedWorkTestHarness.ts";

const isAcceptedNativeCommit = Schema.is(
  Schema.Struct({ receipt: CommandReceiptV2, committed: Schema.Boolean }),
);
const isDispatchError = Schema.is(OrchestratorDispatchError);
type Scenario =
  | "close"
  | "replacement"
  | "scope"
  | "transport"
  | "scope-commit"
  | "commit"
  | "interrupt"
  | "stop"
  | "missing";

const runAdmissionRace = (scenario: Scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const afterLookup = yield* Deferred.make<ProviderAdapterV2InitiatedWorkIdentity>();
      const releaseLookup = yield* Deferred.make<void>();
      const commitEntered = yield* Deferred.make<{
        commandId: CommandId;
        messageId: MessageId;
        runId: RunId;
        sequence: number;
      }>();
      const releaseCommit = yield* Deferred.make<void>();
      const scopeCloseEntered = yield* Deferred.make<void>();
      const invalidationEntered = yield* Deferred.make<void>();
      const invalidated = yield* Deferred.make<void>();
      const dispatchFailed = yield* Deferred.make<OrchestratorDispatchError>();
      const cleared = yield* Deferred.make<void>();
      let admissionIdentity: ProviderAdapterV2InitiatedWorkIdentity | undefined;
      let planningObserved = false;
      let liveRuntime: ProviderAdapterV2SessionRuntime | undefined;
      let sql: SqlClient.SqlClient | undefined;
      let nativeState: Effect.Effect<void> = Effect.die("Native state not opened");
      let nativeExited: Effect.Effect<number> = Effect.die("Native transport not opened");
      let closeNativeScope: Effect.Effect<void> = Effect.die("Native scope not opened");
      let insideCommit: (commandId: CommandId, sequence: number) => Effect.Effect<void> = () =>
        Effect.die("Native SQL witness not installed");
      const sqlWins =
        scenario === "scope-commit" ||
        scenario === "commit" ||
        scenario === "interrupt" ||
        scenario === "stop";
      const parkedLookup = !sqlWins && scenario !== "missing";

      const probe: PiNativeGenerationAdmissionProbe = {
        extensionPrelude: (h) => `
import fsSync from "node:fs";
fsSync.writeFileSync(${json(`${h.profile}/own-pid`)}, String(process.pid));
void (async () => { while (true) {
  try { await fs.access(${json(`${h.profile}/exit-native`)}); process.exit(19); } catch {}
  await new Promise(resolve => setTimeout(resolve, 10));
}})();`,
        observeConnection: (connection) => {
          nativeExited = connection.exited.pipe(Effect.orDie);
          nativeState = connection.request({ type: "get_state" }).pipe(Effect.asVoid, Effect.orDie);
        },
        wrapOpen: (open) =>
          Effect.gen(function* () {
            const owned = yield* Scope.make("parallel");
            yield* Effect.addFinalizer((exit) => Scope.close(owned, exit));
            closeNativeScope = Deferred.succeed(scopeCloseEntered, undefined).pipe(
              Effect.andThen(Scope.close(owned, Exit.void)),
            );
            return yield* open.pipe(Effect.provideService(Scope.Scope, owned));
          }),
        wrapRuntime: (runtime) => {
          liveRuntime = runtime;
          const { withInitiatedWorkAdmission: nativeAdmission, ...base } = runtime;
          return {
            ...base,
            get providerSession() {
              return runtime.providerSession;
            },
            invalidateInitiatedWork: (reserve) =>
              Deferred.succeed(invalidationEntered, undefined).pipe(
                Effect.andThen(runtime.invalidateInitiatedWork!(reserve)),
                Effect.tap((reserved) =>
                  reserved
                    ? Deferred.succeed(invalidated, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
            ...(scenario === "missing"
              ? {}
              : {
                  withInitiatedWorkAdmission: <A, E, R>(
                    identity: ProviderAdapterV2InitiatedWorkIdentity,
                    commit: Effect.Effect<A, E, R>,
                  ) =>
                    Effect.suspend(() => {
                      if (planningObserved) return nativeAdmission!(identity, commit);
                      planningObserved = true;
                      admissionIdentity = identity;
                      return Deferred.succeed(afterLookup, identity).pipe(
                        Effect.andThen(parkedLookup ? Deferred.await(releaseLookup) : Effect.void),
                        Effect.andThen(nativeAdmission!(identity, commit)),
                      );
                    }),
                }),
          };
        },
        decorateWorkRequest: (request) => ({
          ...request,
          dispatchIfCurrent: (dispatch) =>
            request.dispatchIfCurrent!(dispatch).pipe(
              Effect.tapError((error) =>
                isDispatchError(error)
                  ? Deferred.succeed(dispatchFailed, error).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
          clearIfCurrent: () =>
            request.clearIfCurrent!().pipe(Effect.tap(() => Deferred.succeed(cleared, undefined))),
        }),
        databaseLayer: (h) => {
          const real = makeSqlitePersistenceLive(
            `${h.serverConfig.stateDir}/pig-${h.root.split("/").at(-1)}.sqlite`,
          ).pipe(Layer.provide(NodeServices.layer));
          return Layer.effect(
            SqlClient.SqlClient,
            Effect.gen(function* () {
              const client = yield* SqlClient.SqlClient;
              sql = client;
              // Tap the real transaction body after receipt/events/projection/outbox
              // writes and before its real COMMIT. Do not add an outer transaction
              // or replace EventSink's writer/publication.
              const withTransaction: typeof client.withTransaction = (body) =>
                client.withTransaction(
                  body.pipe(
                    Effect.tap((result) =>
                      sqlWins &&
                      isAcceptedNativeCommit(result) &&
                      result.committed &&
                      result.receipt.commandType === "provider-work.admit"
                        ? insideCommit(
                            result.receipt.commandId,
                            result.receipt.resultSequence,
                          ).pipe(Effect.orDie)
                        : Effect.void,
                    ),
                  ),
                );
              return new Proxy(client, {
                get: (target, property, receiver) =>
                  property === "withTransaction"
                    ? withTransaction
                    : Reflect.get(target, property, receiver),
              });
            }),
          ).pipe(Layer.provide(real), Layer.orDie);
        },
        verify: (ctx) =>
          Effect.gen(function* () {
            if (sql === undefined || liveRuntime === undefined)
              return yield* Effect.die("Missing actual native/SQL owner");
            const client = sql;
            const runtime = liveRuntime;
            const pid = Number(
              (yield* ctx.fixture.fs.readFileString(`${ctx.fixture.profile}/own-pid`)).trim(),
            );
            assert.isTrue(Number.isSafeInteger(pid));
            assert.isAbove(pid, 1);
            process.kill(pid, 0);
            const awaitPidExit = (ownedPid: number): Effect.Effect<void> =>
              Effect.sync(() => {
                try {
                  process.kill(ownedPid, 0);
                  return false;
                } catch (error) {
                  assert.match(String(error), /ESRCH/);
                  return true;
                }
              }).pipe(
                Effect.flatMap((exited) =>
                  exited
                    ? Effect.void
                    : Effect.sleep("10 millis").pipe(
                        Effect.andThen(Effect.suspend(() => awaitPidExit(ownedPid))),
                      ),
                ),
              );
            const awaitPhysicalExit = awaitPidExit(pid);
            assert.isTrue(ctx.wire.some((record) => record.type === "get_state"));
            assert.lengthOf(ctx.foreground.runs, 1);
            assert.equal(ctx.foreground.runs[0]?.status, "completed");
            assert.lengthOf(ctx.requests, 0);
            const noAcceptedNativeRows = (commandId: CommandId) =>
              Effect.gen(function* () {
                assert.isTrue(Option.isNone(yield* ctx.receipts.getByCommandId(commandId)));
                assert.deepEqual(
                  yield* client`SELECT command_id FROM orchestration_command_receipts WHERE command_id = ${commandId}`,
                  [],
                );
                assert.deepEqual(
                  yield* client`SELECT sequence FROM orchestration_events WHERE command_id = ${commandId}`,
                  [],
                );
                assert.deepEqual(
                  yield* client`SELECT effect_id FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}`,
                  [],
                );
                const p = yield* ctx.orchestrator.getThreadProjection(ctx.fixture.threadId);
                assert.lengthOf(p.runs, 1);
                assert.lengthOf(p.providerTurns, 1);
                assert.isFalse(
                  p.messages.some(
                    (message) => message.notification?.source.kind === "provider_work",
                  ),
                );
                assert.deepEqual(
                  yield* client`SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${ctx.fixture.threadId} AND ordinal > 1`,
                  [],
                );
              });
            insideCommit = (commandId, sequence) =>
              Effect.gen(function* () {
                const rows = yield* client<{
                  status: string;
                  result_sequence: number;
                }>`SELECT status, result_sequence FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
                assert.lengthOf(rows, 1);
                assert.equal(rows[0]?.status, "accepted");
                assert.equal(rows[0]?.result_sequence, sequence);
                const p = yield* ctx.orchestrator.getThreadProjection(ctx.fixture.threadId);
                assert.lengthOf(p.runs, 2);
                assert.lengthOf(p.providerTurns, 1);
                const native = p.messages.find(
                  (message) => message.notification?.source.kind === "provider_work",
                )!;
                assert.isDefined(native);
                assert.equal(
                  native.notification?.source.kind === "provider_work"
                    ? native.notification.source.workId
                    : undefined,
                  admissionIdentity?.workId,
                );
                const effects = yield* client<{
                  effect_type: string;
                  status: string;
                }>`SELECT effect_type, status FROM orchestration_v2_effect_outbox WHERE command_id = ${commandId}`;
                assert.isTrue(
                  effects.some(
                    (row) => row.effect_type === "provider-turn.start" && row.status === "pending",
                  ),
                );
                yield* Deferred.succeed(commitEntered, {
                  commandId,
                  messageId: native.id,
                  runId: p.runs[1]!.id,
                  sequence,
                });
                yield* Deferred.await(releaseCommit);
                if (scenario === "interrupt") return yield* Effect.interrupt;
              }).pipe(Effect.orDie);

            yield* ctx.wake;
            if (scenario === "missing") {
              const failure = yield* Deferred.await(dispatchFailed).pipe(
                Effect.timeout("10 seconds"),
                Effect.catchTags({
                  TimeoutError: () => Effect.die("Native witness timed out: dispatchFailed"),
                }),
              );
              yield* Deferred.await(cleared).pipe(
                Effect.timeout("10 seconds"),
                Effect.catchTags({
                  TimeoutError: () => Effect.die("Native witness timed out: cleared"),
                }),
              );
              yield* noAcceptedNativeRows(failure.commandId);
              assert.lengthOf(ctx.offers, 1);
              yield* ctx.manager.close(runtime.providerSessionId);
              yield* awaitPhysicalExit.pipe(Effect.timeout("10 seconds"));
              assert.throws(() => process.kill(pid, 0), /ESRCH/);
            } else {
              admissionIdentity = yield* Deferred.await(afterLookup).pipe(
                Effect.timeout("10 seconds"),
                Effect.catchTags({
                  TimeoutError: () => Effect.die("Native witness timed out: afterLookup"),
                }),
              );
              assert.equal(admissionIdentity.workId, ctx.offers[0]?.initiated?.workId);
              assert.equal(admissionIdentity.runtimePolicy.cwd, ctx.cwd);
              assert.deepEqual(
                admissionIdentity.modelSelection,
                ctx.offers[0]?.initiated?.modelSelection,
              );
              assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
              process.kill(pid, 0);
              const session = yield* ctx.manager.get(runtime.providerSessionId);
              assert.isTrue(Option.isSome(session));
              if (Option.isNone(session))
                return yield* Effect.die("Missing current canonical session");
              // Exact owner and captured identity controls invoke the real manager/
              // native fence. No callback may run for these identities.
              let unauthorizedCommits = 0;
              if (!sqlWins)
                for (const invalid of [
                  { ...admissionIdentity, workId: `${admissionIdentity.workId}:other` },
                  {
                    ...admissionIdentity,
                    providerThreadId: ProviderThreadId.make("foreign-pig-thread"),
                  },
                  {
                    ...admissionIdentity,
                    providerInstanceId: ProviderInstanceId.make("foreign-pig-instance"),
                  },
                  { ...admissionIdentity, driver: ProviderDriverKind.make("codex") },
                  {
                    ...admissionIdentity,
                    providerSessionId: ProviderSessionId.make("foreign-pig-session"),
                  },
                  { ...admissionIdentity, threadId: ThreadId.make("foreign-pig-thread") },
                  {
                    ...admissionIdentity,
                    modelSelection: {
                      ...admissionIdentity.modelSelection,
                      model: "scient-test/future",
                    },
                  },
                  {
                    ...admissionIdentity,
                    runtimePolicy: { ...admissionIdentity.runtimePolicy, cwd: ctx.workspaceB },
                  },
                ]) {
                  assert.isTrue(
                    Option.isNone(
                      yield* ctx.manager.withProviderWorkAdmission(
                        invalid,
                        session.value,
                        Effect.sync(() => unauthorizedCommits++),
                      ),
                    ),
                  );
                }
              // Raw adapter identity is never the manager's exposed current owner.
              assert.isTrue(
                Option.isNone(
                  yield* ctx.manager.withProviderWorkAdmission(
                    admissionIdentity,
                    runtime,
                    Effect.sync(() => unauthorizedCommits++),
                  ),
                ),
              );
              assert.equal(unauthorizedCommits, 0);

              if (!sqlWins) {
                if (scenario === "close" || scenario === "replacement")
                  yield* ctx.manager
                    .close(runtime.providerSessionId)
                    .pipe(Effect.timeout("10 seconds"));
                else if (scenario === "scope")
                  yield* closeNativeScope.pipe(Effect.timeout("10 seconds"));
                else
                  yield* ctx.fixture.fs.writeFileString(
                    `${ctx.fixture.profile}/exit-native`,
                    "exit",
                  );
                yield* (scenario === "transport" ? nativeExited : awaitPhysicalExit).pipe(
                  Effect.timeout("10 seconds"),
                );
                assert.throws(() => process.kill(pid, 0), /ESRCH/);
                if (scenario !== "close" && scenario !== "replacement")
                  yield* ctx.manager
                    .close(runtime.providerSessionId)
                    .pipe(Effect.timeout("10 seconds"));
                yield* Deferred.await(invalidated).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catchTags({
                    TimeoutError: () => Effect.die("Native witness timed out: invalidated"),
                  }),
                );
                assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
                if (scenario === "replacement") {
                  const replacement = yield* ctx.manager.open({
                    threadId: ctx.fixture.threadId,
                    providerSessionId: runtime.providerSessionId,
                    modelSelection: admissionIdentity.modelSelection,
                    runtimePolicy: admissionIdentity.runtimePolicy,
                  });
                  yield* nativeState;
                  const replacementPid = Number(
                    (yield* ctx.fixture.fs.readFileString(`${ctx.fixture.profile}/own-pid`)).trim(),
                  );
                  assert.isAbove(replacementPid, 1);
                  assert.notEqual(replacementPid, pid);
                  process.kill(replacementPid, 0);
                  assert.isFalse(yield* replacement.hasPendingBackgroundWork!);
                  assert.isTrue(
                    Option.isNone(
                      yield* ctx.manager.withProviderWorkAdmission(
                        admissionIdentity,
                        session.value,
                        Effect.die("Replaced owner committed"),
                      ),
                    ),
                  );
                  assert.isTrue(
                    Option.isNone(
                      yield* ctx.manager.withProviderWorkAdmission(
                        admissionIdentity,
                        replacement,
                        Effect.die("Replacement inherited old generation"),
                      ),
                    ),
                  );
                  yield* ctx.offers[0]!.clearIfCurrent!();
                  process.kill(replacementPid, 0);
                  assert.strictEqual(
                    Option.getOrThrow(yield* ctx.manager.get(runtime.providerSessionId)),
                    replacement,
                  );
                }
                yield* Deferred.succeed(releaseLookup, undefined);
                const failure = yield* Deferred.await(dispatchFailed).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catchTags({
                    TimeoutError: () => Effect.die("Native witness timed out: dispatchFailed"),
                  }),
                );
                yield* Deferred.await(cleared).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catchTags({
                    TimeoutError: () => Effect.die("Native witness timed out: cleared"),
                  }),
                );
                yield* noAcceptedNativeRows(failure.commandId);
                assert.isTrue(
                  Option.isNone(
                    yield* ctx.manager.withProviderWorkAdmission(
                      admissionIdentity,
                      session.value,
                      Effect.die("Disposed generation committed"),
                    ),
                  ),
                );
                if (scenario === "replacement") {
                  const replacementPid = Number(
                    (yield* ctx.fixture.fs.readFileString(`${ctx.fixture.profile}/own-pid`)).trim(),
                  );
                  process.kill(replacementPid, 0);
                  yield* ctx.manager
                    .close(runtime.providerSessionId)
                    .pipe(Effect.timeout("10 seconds"));
                  yield* awaitPidExit(replacementPid).pipe(Effect.timeout("10 seconds"));
                  assert.throws(() => process.kill(replacementPid, 0), /ESRCH/);
                }
              } else {
                const committed = yield* Deferred.await(commitEntered).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catchTags({
                    TimeoutError: () => Effect.die("Native witness timed out: commitEntered"),
                  }),
                );
                const closer = yield* (
                  scenario === "scope-commit"
                    ? closeNativeScope
                    : ctx.manager.close(runtime.providerSessionId)
                ).pipe(Effect.forkScoped);
                yield* Deferred.await(
                  scenario === "scope-commit" ? scopeCloseEntered : invalidationEntered,
                ).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.catchTags({
                    TimeoutError: () => Effect.die("Native witness timed out: invalidationEntered"),
                  }),
                );
                if (scenario === "scope-commit") yield* nativeState;
                assert.isUndefined(closer.pollUnsafe());
                assert.isFalse(yield* Deferred.isDone(invalidated));
                assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
                process.kill(pid, 0);
                const stopped =
                  scenario === "stop"
                    ? yield* ctx.orchestrator
                        .dispatch({
                          type: "run.interrupt",
                          commandId: CommandId.make("pig-ordered-stop"),
                          threadId: ctx.fixture.threadId,
                          runId: committed.runId,
                          holdQueue: true,
                        })
                        .pipe(Effect.forkScoped)
                    : undefined;
                yield* Deferred.succeed(releaseCommit, undefined);
                yield* Fiber.join(closer).pipe(Effect.timeout("10 seconds"));
                if (scenario === "scope-commit")
                  yield* ctx.manager
                    .close(runtime.providerSessionId)
                    .pipe(Effect.timeout("10 seconds"));
                if (stopped !== undefined)
                  yield* Fiber.join(stopped).pipe(Effect.timeout("10 seconds"));
                yield* awaitPhysicalExit.pipe(Effect.timeout("10 seconds"));
                assert.throws(() => process.kill(pid, 0), /ESRCH/);
                if (scenario === "interrupt") {
                  yield* Deferred.await(cleared).pipe(
                    Effect.timeout("10 seconds"),
                    Effect.catchTags({
                      TimeoutError: () => Effect.die("Native witness timed out: cleared"),
                    }),
                  );
                  yield* noAcceptedNativeRows(committed.commandId);
                } else {
                  const receipt = yield* ctx.receipts.getByCommandId(committed.commandId);
                  assert.isTrue(Option.isSome(receipt));
                  if (Option.isSome(receipt)) {
                    assert.equal(receipt.value.status, "accepted");
                    assert.equal(receipt.value.resultSequence, committed.sequence);
                  }
                  const p = yield* ctx.orchestrator.getThreadProjection(ctx.fixture.threadId);
                  assert.lengthOf(p.runs, 2);
                  assert.lengthOf(
                    p.messages.filter(
                      (message) => message.notification?.source.kind === "provider_work",
                    ),
                    1,
                  );
                  const packet = ctx.offers[0]!;
                  const replay = yield* ctx.orchestrator.dispatch({
                    type: "provider-work.admit",
                    commandId: committed.commandId,
                    messageId: committed.messageId,
                    threadId: packet.threadId,
                    providerThreadId: packet.providerThreadId,
                    driver: packet.driver,
                    ...packet.initiated!,
                    detail: packet.detail ?? "Provider started background work.",
                  });
                  assert.equal(replay.sequence, committed.sequence);
                  assert.lengthOf(
                    (yield* ctx.orchestrator.getThreadProjection(ctx.fixture.threadId)).runs,
                    2,
                  );
                }
              }
            }
            assert.lengthOf(ctx.offers, 1);
            assert.lengthOf(
              ctx.wire.filter((record) => record.type === "prompt"),
              1,
            );
            assert.lengthOf(
              ctx.wire.filter(
                (record) => record.type === "switch_session" || record.type === "new_session",
              ),
              0,
            );
          }).pipe(Effect.orDie),
      };
      yield* runNativeInitiatedWorkScenario("plain", probe);
    }),
  );

it.layer(layer, { excludeTestServices: true })(
  "actual Pi generation admission linearization",
  (it) => {
    for (const scenario of [
      "close",
      "replacement",
      "scope",
      "transport",
      "scope-commit",
      "commit",
      "interrupt",
      "stop",
      "missing",
    ] as const) {
      it.effect.skipIf(!binary)(
        `keeps canonical SQL admission ordered with actual native ${scenario}`,
        () => runAdmissionRace(scenario),
        60000,
      );
    }
  },
);
