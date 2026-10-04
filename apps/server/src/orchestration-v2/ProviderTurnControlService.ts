import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { prepareScientV2SkillTurn } from "../scient/skills/ScientV2SkillTurn.ts";
import { ScientSkillSessionPlanner } from "../scient/skills/ScientSkillSession.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const yieldToRuntime = Effect.yieldNow.pipe(
  Effect.andThen(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }),
    ),
  ),
);

export class ProviderTurnControlError extends Schema.TaggedError<ProviderTurnControlError>()(
  "ProviderTurnControlError",
  {
    threadId: ThreadId,
    operation: Schema.Literals(["interrupt", "restart", "steer"]),
    providerTurnId: ProviderTurnId,
    turnCompleted: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnControlError = Schema.is(ProviderTurnControlError);

/** Private pending-start control: native turn identity is not invented before its receipt. */
export class ProviderRunInterruptError extends Schema.TaggedError<ProviderRunInterruptError>()(
  "ProviderRunInterruptError",
  {
    threadId: ThreadId,
    runId: RunId,
    reason: Schema.Literals(["receipt_pending", "lookup_failed", "native_interrupt_failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderRunInterruptError = Schema.is(ProviderRunInterruptError);

export interface ProviderTurnControlServiceV2Shape {
  readonly interruptPendingStart: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly expectedAttemptId: RunAttemptId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
  }) => Effect.Effect<Option.Option<ProviderTurnId>, ProviderRunInterruptError>;
  readonly interrupt: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly steer: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
  readonly interruptAndAwaitTerminal: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly replacementProviderSessionId?: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerTurnId: ProviderTurnId;
    readonly interruptedAttemptId: RunAttemptId;
  }) => Effect.Effect<void, ProviderTurnControlError>;
}

export class ProviderTurnControlServiceV2 extends Context.Service<
  ProviderTurnControlServiceV2,
  ProviderTurnControlServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnControlService/ProviderTurnControlServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnControlServiceV2,
  never,
  ProjectionStore.ProjectionStoreV2 | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  ProviderTurnControlServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const skillPlanner = yield* ScientSkillSessionPlanner;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    const load = (input: {
      readonly threadId: ThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly replacementProviderSessionId?: ProviderSessionId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerTurnId: ProviderTurnId;
      readonly operation: "interrupt" | "restart" | "steer";
      readonly messageId?: MessageId;
    }) =>
      Effect.gen(function* () {
        const context = yield* projections.getProviderControlContext(input.threadId, input);
        const { providerThread, providerTurn } = context;
        const targetsRecordedSession =
          providerThread?.providerSessionId === input.providerSessionId;
        const targetsCommittedReplacement =
          input.operation === "restart" &&
          input.replacementProviderSessionId !== undefined &&
          providerThread?.providerSessionId === input.replacementProviderSessionId;
        if (
          providerThread === undefined ||
          providerTurn === undefined ||
          (!targetsRecordedSession && !targetsCommittedReplacement) ||
          providerTurn.providerThreadId !== providerThread.id
        ) {
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: "The recorded provider execution target is no longer valid.",
          });
        }
        // A restart-session command commits the replacement binding before its
        // process-bound effect runs. The old live runtime must still receive
        // the interrupt, but only when the projection matches the exact
        // replacement captured by that same durable effect.
        const interruptProviderThread = targetsRecordedSession
          ? providerThread
          : { ...providerThread, providerSessionId: input.providerSessionId };
        if (providerTurn.status !== "running") {
          if (input.operation === "steer") {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              turnCompleted: providerTurn.status === "completed",
              cause: "The provider turn ended before the steering message was delivered.",
            });
          }
          return {
            context,
            providerThread: interruptProviderThread,
            providerTurn,
            session: Option.none(),
          };
        }
        const session = yield* sessions.get(input.providerSessionId);
        if (Option.isNone(session)) {
          // Interrupt/restart against a already-released session must not fail
          // the durable effect (and retry 5x). The turn may still look running
          // in projection until recovery/finalization; there is no live adapter
          // to interrupt.
          if (input.operation === "interrupt" || input.operation === "restart") {
            yield* Effect.logWarning(
              "Provider interrupt/restart found no live session; treating as already stopped",
              {
                threadId: input.threadId,
                operation: input.operation,
                providerSessionId: input.providerSessionId,
                providerTurnId: input.providerTurnId,
                providerTurnStatus: providerTurn.status,
              },
            );
            return {
              context,
              providerThread: interruptProviderThread,
              providerTurn,
              session: Option.none(),
            };
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: input.operation,
            providerTurnId: input.providerTurnId,
            cause: `Provider session ${input.providerSessionId} is not active.`,
          });
        }
        return { context, providerThread: interruptProviderThread, providerTurn, session };
      });

    const interrupt: ProviderTurnControlServiceV2Shape["interrupt"] = (input) =>
      Effect.gen(function* () {
        const loaded = yield* load({ ...input, operation: "interrupt" });
        const session = Option.isSome(loaded.session)
          ? loaded.session
          : yield* sessions.get(input.providerSessionId);
        if (Option.isNone(session)) return;
        // A settled turn reaches its adapter too: only the adapter knows
        // whether it still runs work for the thread, and each one either
        // stops it or reports there is nothing left to stop. Background work
        // the projection still shows is settled by the orchestrator after.
        yield* session.value.interruptTurn({
          providerThread: loaded.providerThread,
          providerTurnId: loaded.providerTurn.id,
          requestRuntimeRestart: true,
        });
      }).pipe(
        Effect.mapError((cause) =>
          isProviderTurnControlError(cause)
            ? cause
            : new ProviderTurnControlError({
                threadId: input.threadId,
                operation: "interrupt",
                providerTurnId: input.providerTurnId,
                cause,
              }),
        ),
      );

    return ProviderTurnControlServiceV2.of({
      interrupt,
      interruptPendingStart: (input) =>
        Effect.gen(function* () {
          const projection = yield* projections.getThreadRecords(input.threadId, [
            "runs",
            "attempts",
            "nodes",
            "providerThreads",
            "providerTurns",
          ]);
          if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
            return Option.none();
          const run = projection.runs.find((candidate) => candidate.id === input.runId);
          if (
            run === undefined ||
            run.status !== "running" ||
            run.activeAttemptId !== input.expectedAttemptId ||
            run.providerThreadId !== input.providerThreadId ||
            projection.thread.activeProviderThreadId !== input.providerThreadId
          )
            return Option.none();
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === input.expectedAttemptId,
          );
          const root = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          const thread = projection.providerThreads.find(
            (candidate) => candidate.id === input.providerThreadId,
          );
          if (
            attempt === undefined ||
            root === undefined ||
            thread === undefined ||
            attempt.runId !== run.id ||
            attempt.status !== "running" ||
            attempt.rootNodeId !== root.id ||
            attempt.providerThreadId !== thread.id ||
            attempt.providerInstanceId !== run.providerInstanceId ||
            root.runId !== run.id ||
            root.threadId !== input.threadId ||
            root.rootNodeId !== root.id ||
            root.providerThreadId !== thread.id ||
            root.status !== "running" ||
            thread.appThreadId !== input.threadId ||
            thread.providerInstanceId !== run.providerInstanceId ||
            thread.providerSessionId !== input.providerSessionId
          )
            return Option.none();
          const turn = projection.providerTurns.findLast(
            (candidate) =>
              candidate.runAttemptId === attempt.id &&
              candidate.nodeId === root.id &&
              candidate.providerThreadId === thread.id &&
              (attempt.providerTurnId === null || candidate.id === attempt.providerTurnId),
          );
          if (turn === undefined)
            return yield* new ProviderRunInterruptError({
              threadId: input.threadId,
              runId: input.runId,
              reason: "receipt_pending",
            });
          if (turn.status !== "running") return Option.none();
          yield* interrupt({
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
            providerThreadId: thread.id,
            providerTurnId: turn.id,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRunInterruptError({
                  threadId: input.threadId,
                  runId: input.runId,
                  reason: "native_interrupt_failed",
                  cause,
                }),
            ),
          );
          return Option.some(turn.id);
        }).pipe(
          Effect.mapError((cause) =>
            isProviderRunInterruptError(cause)
              ? cause
              : new ProviderRunInterruptError({
                  threadId: input.threadId,
                  runId: input.runId,
                  reason: "lookup_failed",
                  cause,
                }),
          ),
        ),
      interruptAndAwaitTerminal: (input) =>
        Effect.gen(function* () {
          const loaded = yield* load({ ...input, operation: "restart" });
          if (Option.isNone(loaded.session)) {
            // No live adapter: nothing can emit a terminal provider-turn update
            // from interrupt. Do not poll for projection terminalization or the
            // restart effect stalls; let detach/start proceed.
            if (loaded.providerTurn.status === "running") {
              yield* Effect.logWarning(
                "Provider restart interrupt skipped; no live session for a still-projected running turn",
                {
                  threadId: input.threadId,
                  providerSessionId: input.providerSessionId,
                  providerTurnId: input.providerTurnId,
                },
              );
            }
            return;
          }

          yield* loaded.session.value.interruptTurn({
            providerThread: loaded.providerThread,
            providerTurnId: loaded.providerTurn.id,
          });

          for (let remaining = 1_000; remaining > 0; remaining -= 1) {
            const { providerTurn, attempt } = yield* projections.getProviderControlContext(
              input.threadId,
              {
                providerThreadId: input.providerThreadId,
                providerTurnId: input.providerTurnId,
                attemptId: input.interruptedAttemptId,
              },
            );
            if (
              providerTurn !== undefined &&
              providerTurn.status !== "running" &&
              attempt !== undefined &&
              attempt.status !== "running"
            ) {
              return;
            }
            // Provider terminal events are projected on a detached ingestion
            // fiber. Yield through the Node event loop instead of sleeping on
            // Effect's clock so deterministic runtimes cannot deadlock a
            // command that is waiting for that projection.
            yield* yieldToRuntime;
          }
          return yield* new ProviderTurnControlError({
            threadId: input.threadId,
            operation: "restart",
            providerTurnId: input.providerTurnId,
            cause: `Provider turn ${input.providerTurnId} did not terminalize before restart.`,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "restart",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
      steer: (input) =>
        Effect.gen(function* () {
          const context = yield* projections.getProviderControlContext(input.threadId, input);
          const ownership = context.message?.delegatedCompletion;
          if (ownership !== undefined) {
            const projection = yield* projections.getThreadRecords(input.threadId, ["runs"], {
              runIds: [ownership.parentRunId],
            });
            const cohort = projection.runs.find(
              (run) => run.id === ownership.parentRunId,
            )?.delegatedCompletion;
            if (
              cohort?.disposition !== "open" ||
              cohort.delivery?.messageId !== input.messageId ||
              cohort.delivery.generation !== ownership.generation ||
              cohort.delivery.taskIds.length === 0
            )
              return;
          }
          const loaded = yield* load({ ...input, operation: "steer" });
          if (Option.isNone(loaded.session)) return;
          const { message, run } = loaded.context;
          if (message === undefined || run === undefined) {
            return yield* new ProviderTurnControlError({
              threadId: input.threadId,
              operation: "steer",
              providerTurnId: input.providerTurnId,
              cause: "The persisted steering message or target run is missing.",
            });
          }
          const text = yield* prepareScientV2SkillTurn({
            threadId: input.threadId,
            driver: loaded.session.value.driver,
            mcpSessionInjection: loaded.session.value.mcpSessionInjection === true,
            projectRoot: loaded.session.value.providerSession.cwd ?? undefined,
            text: projectComposerContextForProvider({
              text: message.text,
              records: message.context?.records ?? [],
            }),
            selectedScientSkillNames: message.selectedScientSkillNames ?? [],
          }).pipe(Effect.provideService(ScientSkillSessionPlanner, skillPlanner));
          yield* loaded.session.value
            .steerTurn({
              threadId: input.threadId,
              runId: run.id,
              providerThread: loaded.providerThread,
              providerTurnId: loaded.providerTurn.id,
              message: {
                messageId: message.id,
                text,
                attachments: message.attachments,
                createdBy: message.createdBy,
                creationSource: message.creationSource,
                ...(message.scheduledTaskId === undefined
                  ? {}
                  : { scheduledTaskId: message.scheduledTaskId }),
                ...(message.senderThreadId === undefined
                  ? {}
                  : { senderThreadId: message.senderThreadId }),
              },
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  const current = yield* projections.getProviderControlContext(
                    input.threadId,
                    input,
                  );
                  return yield* new ProviderTurnControlError({
                    threadId: input.threadId,
                    operation: "steer",
                    providerTurnId: input.providerTurnId,
                    turnCompleted: current.providerTurn?.status === "completed",
                    cause,
                  });
                }),
              ),
            );
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnControlError(cause)
              ? cause
              : new ProviderTurnControlError({
                  threadId: input.threadId,
                  operation: "steer",
                  providerTurnId: input.providerTurnId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
