import { DroidSteerDeferred, DroidSteerUncertain } from "./Adapters/DroidSteerSafety.ts";
import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  increment,
  metricAttributes,
  orchestrationEffectClaimsTotal,
  orchestrationEffectQueueWait,
} from "../observability/Metrics.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import { AttachmentRollbackPruneService } from "./AttachmentRollbackPruneService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import { ConversationForkService } from "./scient-fork/ConversationForkService.ts";
// SCIENT-FORK:START checkpoint-capture-final-attempt
import {
  CheckpointCaptureFinalAttempt,
  isCheckpointSettlementPending,
} from "./scient-fork/CheckpointCaptureFinalAttempt.ts";
// SCIENT-FORK:END checkpoint-capture-final-attempt

export class OrchestrationEffectExecutionError extends Schema.TaggedError<OrchestrationEffectExecutionError>()(
  "OrchestrationEffectExecutionError",
  {
    effectId: Schema.String,
    effectType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderRunInterruptError = Schema.is(ProviderTurnControlService.ProviderRunInterruptError);

/**
 * Pure interrupt races with hard process teardown or a dead session produce
 * "not active" protocol errors. Retrying those only delays recovery.
 *
 * Do not apply this to `provider-turn.restart`: that compound effect also runs
 * detach and start. Swallowing a start failure that happens to mention
 * "is not active" would drop the outbox item without ever starting the
 * replacement turn.
 */
export function isNonRetryableProviderTurnControlFailure(
  effectType: string,
  errorText: string,
): boolean {
  if (effectType !== "provider-turn.interrupt") {
    return false;
  }
  return (
    /is not active/i.test(errorText) ||
    /hard teardown is already in progress/i.test(errorText) ||
    /treating as already interrupted/i.test(errorText) ||
    /treating as already stopped/i.test(errorText)
  );
}

export interface OrchestrationEffectExecutorV2Shape {
  /**
   * Runs one claimed effect. `willRetry` is true when the worker will retry a
   * failure, so a step can fail and try again instead of settling the run.
   */
  readonly execute: (
    effect: EffectOutbox.OrchestrationEffectV2,
    options?: { readonly willRetry: boolean },
  ) => Effect.Effect<void, OrchestrationEffectExecutionError>;
}

export class OrchestrationEffectExecutorV2 extends Context.Service<
  OrchestrationEffectExecutorV2,
  OrchestrationEffectExecutorV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectExecutorV2") {}

export const layerExecutor: Layer.Layer<
  OrchestrationEffectExecutorV2,
  never,
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunFinalizationService.RunFinalizationService
  | CheckpointRollbackService.CheckpointRollbackServiceV2
  | ProviderTurnControlService.ProviderTurnControlServiceV2
  | ProviderTurnStartService.ProviderTurnStartServiceV2
  | RuntimeRequestService.RuntimeRequestServiceV2
  | ThreadTitleRegenerationService.ThreadTitleRegenerationService
  | ThreadManagementService.ThreadManagementService
  | ServerSettings.ServerSettingsService
  | ConversationForkService
> = Layer.effect(
  OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const runFinalization = yield* RunFinalizationService.RunFinalizationService;
    const resourceCleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const rollbackPrune = yield* AttachmentRollbackPruneService;
    const checkpointRollback = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const providerTurnControl = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
    const providerTurnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
    const runtimeRequests = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const threadTitleRegeneration =
      yield* ThreadTitleRegenerationService.ThreadTitleRegenerationService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const conversationForks = yield* ConversationForkService;
    return OrchestrationEffectExecutorV2.of({
      execute: (effect, options) => {
        const willRetry = options?.willRetry ?? false;
        switch (effect.request.type) {
          case "scient-fork.provision":
            return conversationForks.provision(effect.threadId, willRetry).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "provider-runtime.continue": {
            const sourceRunId = effect.request.sourceRunId;
            return continueRestartedRun({
              threadId: effect.threadId,
              sourceRunId,
              ...(effect.request.updateRequested === true ? { updateRequested: true } : {}),
            }).pipe(
              Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
              Effect.provideService(ServerSettings.ServerSettingsService, settings),
              // A continuation that will never run still owes a delegated parent a result.
              Effect.tapError(() =>
                willRetry
                  ? Effect.void
                  : threads.recoverDelegatedTask(effect.threadId, sourceRunId),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          }
          case "provider-session.detach":
            return providerSessions
              .detach({
                providerSessionId: effect.request.providerSessionId,
                threadId: effect.threadId,
                ...(effect.request.detail === undefined ? {} : { detail: effect.request.detail }),
                ...(effect.request.revokeMcpCredential === undefined
                  ? {}
                  : { revokeMcpCredential: effect.request.revokeMcpCredential }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.start":
            return providerTurnStart
              .start({
                threadId: effect.threadId,
                runId: effect.request.runId,
                willRetry,
                ...(effect.request.expectedAttemptId === undefined
                  ? {}
                  : { expectedAttemptId: effect.request.expectedAttemptId }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-run.interrupt": {
            const request = effect.request;
            return providerTurnControl
              .interruptPendingStart({
                threadId: effect.threadId,
                runId: request.runId,
                expectedAttemptId: request.expectedAttemptId,
                providerSessionId: request.providerSessionId,
                providerThreadId: request.providerThreadId,
              })
              .pipe(
                Effect.flatMap((interrupted) =>
                  Option.isNone(interrupted)
                    ? Effect.void
                    : threads
                        .dispatch({
                          type: "thread.background-work.settle",
                          commandId: CommandId.make(`${effect.commandId}:background-work-settled`),
                          threadId: effect.threadId,
                          providerThreadId: request.providerThreadId,
                          providerTurnId: interrupted.value,
                        })
                        .pipe(Effect.asVoid),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          }
          case "provider-turn.interrupt":
            return providerTurnControl
              .interrupt({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
              })
              .pipe(
                Effect.catch((cause) =>
                  isNonRetryableProviderTurnControlFailure(
                    effect.request.type,
                    Cause.pretty(Cause.fail(cause)),
                  )
                    ? Effect.void
                    : Effect.fail(cause),
                ),
                // The provider has stopped what it still ran and reported it.
                // Whatever the thread still shows on that provider thread is
                // work no process will report on, so the Stop ends it too.
                // One Stop can interrupt several provider threads, so the
                // settle is keyed by effect, not by the Stop command.
                Effect.andThen(
                  threads.dispatch({
                    type: "thread.background-work.settle",
                    commandId: CommandId.make(`${effect.id}:background-work-settled`),
                    threadId: effect.threadId,
                    providerThreadId: effect.request.providerThreadId,
                    providerTurnId: effect.request.providerTurnId,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.steer":
            return providerTurnControl
              .steer({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
                messageId: effect.request.messageId,
              })
              .pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (effect.request.type !== "provider-turn.steer") return;
                    const messageId = effect.request.messageId;
                    const projection = yield* threads.getThreadRecords(
                      effect.threadId,
                      ["messages", "runs"],
                      { messageIds: [effect.request.messageId] },
                    );
                    const message = projection.messages.find((row) => row.id === messageId);
                    if (message?.delegatedCompletion === undefined) return;
                    yield* threads.dispatch({
                      type: "notification.delivery.accept",
                      commandId: CommandId.make(`command:mailbox-accepted:${effect.id}`),
                      threadId: effect.threadId,
                      messageId: message.id,
                    });
                  }),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    if (
                      !("turnCompleted" in error) ||
                      !error.turnCompleted ||
                      effect.request.type !== "provider-turn.steer"
                    ) {
                      return yield* error;
                    }
                    const projection = yield* threads.getThreadRecords(
                      effect.threadId,
                      ["messages", "runs"],
                      { messageIds: [effect.request.messageId] },
                    );
                    const messageId = effect.request.messageId;
                    const message = projection.messages.find((item) => item.id === messageId);
                    const run = projection.runs.find((item) => item.id === message?.runId);
                    if (message === undefined || run === undefined) return yield* error;
                    // Reuse the message identity and a stable command receipt so an outbox
                    // retry cannot append a duplicate message or start a second follow-up.
                    yield* threads.dispatch({
                      type: "message.dispatch",
                      commandId: CommandId.make(`command:steer-follow-up:${effect.id}`),
                      threadId: effect.threadId,
                      messageId: message.id,
                      text: message.text,
                      ...(message.context ? { context: message.context } : {}),
                      attachments: message.attachments,
                      ...(message.selectedScientSkillNames === undefined
                        ? {}
                        : { selectedScientSkillNames: message.selectedScientSkillNames }),
                      // A user's follow-up starts on the thread's saved selection,
                      // which already holds the steer's choice. A delegated
                      // completion stays pinned to the run it reports to.
                      ...(message.delegatedCompletion === undefined
                        ? {}
                        : { modelSelection: run.modelSelection }),
                      dispatchMode: {
                        type:
                          message.delegatedCompletion === undefined
                            ? "start_immediately"
                            : "queue_after_active",
                      },
                      createdBy: message.createdBy,
                      creationSource: message.creationSource,
                      ...(message.delegatedCompletion === undefined
                        ? {}
                        : { delegatedCompletion: message.delegatedCompletion }),
                      ...(message.notification === undefined
                        ? {}
                        : { notification: message.notification }),
                      ...(message.scheduledTaskId === undefined
                        ? {}
                        : { scheduledTaskId: message.scheduledTaskId }),
                      ...(message.senderThreadId === undefined
                        ? {}
                        : { senderThreadId: message.senderThreadId }),
                    });
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-turn.restart": {
            // SCIENT-FORK:START — a held effect is an admission request, not permission to cancel.
            if (
              effect.id ===
              `effect:${effect.commandId}:droid-held-steer:${effect.request.providerTurnId}`
            ) {
              const request = effect.request;
              return Effect.gen(function* () {
                const read = threads.getThreadRecords(effect.threadId, [
                  "runs",
                  "providerThreads",
                  "providerTurns",
                ]);
                const initial = yield* read;
                const run = initial.runs.find((run) => run.id === request.runId);
                const held = run?.heldDroidSteer;
                if (
                  held?.revision !== effect.commandId ||
                  run?.activeAttemptId !== request.interruptedAttemptId ||
                  run.status !== "running"
                )
                  return;
                const owner = yield* providerSessions.get(request.providerSessionId);
                if (
                  Option.isNone(owner) ||
                  owner.value.reserveDroidSteer === undefined ||
                  owner.value.consumeDroidSteer === undefined
                )
                  return yield* new DroidSteerUncertain({
                    message:
                      "Held Droid admission has no live native owner; recovery must not replay it.",
                  });
                const session = owner.value;
                let lease = held.admissionLease;
                const command = (operation: "claim" | "defer" | "complete", token: string) =>
                  threads.dispatch({
                    type: "droid-steer.admission",
                    commandId: CommandId.make(`droid-${operation}:${token}`),
                    threadId: effect.threadId,
                    runId: request.runId,
                    revision: effect.commandId,
                    operation,
                    lease: token,
                  });
                if (held.phase === "pre_admission") {
                  // A persisted claim never authorizes cancel after reopen. Only this live consumed token can finish SQL.
                  if (lease === undefined || session.droidSteerConsumed?.(lease) !== true)
                    return yield* new DroidSteerUncertain({
                      message:
                        "Uncertain Droid pre-admission requires explicit recovery; no native replay.",
                    });
                } else {
                  lease = yield* session.reserveDroidSteer!({
                    attemptId: held.sourceAttemptId,
                    providerTurnId: held.sourceProviderTurnId,
                    revision: held.revision,
                  });
                  if (lease === undefined) return yield* new DroidSteerDeferred();
                  const token = lease;
                  yield* command("claim", token).pipe(
                    Effect.catch((error) => {
                      const lostReadiness = session.validateDroidSteer?.(token) !== true;
                      session.invalidateDroidSteer?.();
                      return Effect.fail(lostReadiness ? new DroidSteerDeferred() : error);
                    }),
                  );
                  const claimed = yield* read;
                  const current = claimed.runs.find(
                    (run) => run.id === request.runId,
                  )?.heldDroidSteer;
                  if (current?.revision !== effect.commandId || current.admissionLease !== lease)
                    return;
                  const providerThread = claimed.providerThreads.find(
                    (thread) => thread.id === request.providerThreadId,
                  );
                  if (providerThread === undefined)
                    return yield* new DroidSteerUncertain({
                      message: "Held Droid provider thread is missing.",
                    });
                  const consumed = yield* session.consumeDroidSteer!({
                    providerThread,
                    providerTurnId: request.providerTurnId,
                    droidSteerLease: lease,
                  }).pipe(
                    Effect.mapError((error) =>
                      session.droidSteerConsumed?.(lease) === true
                        ? new DroidSteerUncertain({
                            message: `Native Droid admission failed after consumption: ${error.message}`,
                          })
                        : error,
                    ),
                  );
                  if (!consumed) {
                    yield* command("defer", lease);
                    return yield* new DroidSteerDeferred();
                  }
                }
                const settled = yield* read;
                const current = settled.runs.find(
                  (run) => run.id === request.runId,
                )?.heldDroidSteer;
                if (current?.revision !== effect.commandId) return;
                if (
                  settled.providerTurns.some(
                    (turn) => turn.id === request.providerTurnId && turn.status === "running",
                  )
                )
                  return yield* new DroidSteerDeferred();
                yield* command("complete", lease);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: request.type,
                      cause,
                    }),
                ),
              );
            }
            // SCIENT-FORK:END
            return providerTurnControl
              .interruptAndAwaitTerminal({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                providerThreadId: effect.request.providerThreadId,
                providerTurnId: effect.request.providerTurnId,
                interruptedAttemptId: effect.request.interruptedAttemptId,
                ...(effect.request.sessionTransition?.type === "replace"
                  ? {
                      replacementProviderSessionId:
                        effect.request.sessionTransition.replacementProviderSessionId,
                    }
                  : {}),
              })
              .pipe(
                Effect.andThen(
                  effect.request.sessionTransition?.type === "replace"
                    ? providerSessions.detach({
                        providerSessionId: effect.request.providerSessionId,
                        threadId: effect.threadId,
                        detail: "Selection change requires a provider session restart.",
                      })
                    : effect.request.sessionTransition?.type === "detach"
                      ? providerSessions.detach({
                          providerSessionId: effect.request.providerSessionId,
                          threadId: effect.threadId,
                          detail: "Provider thread handoff replaced this session binding.",
                        })
                      : Effect.void,
                ),
                Effect.andThen(
                  providerTurnStart.start({
                    threadId: effect.threadId,
                    runId: effect.request.runId,
                    willRetry,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          }
          case "runtime-request.respond":
            return runtimeRequests
              .respond({
                threadId: effect.threadId,
                providerSessionId: effect.request.providerSessionId,
                requestId: effect.request.requestId,
                ...(effect.request.decision === undefined
                  ? {}
                  : { decision: effect.request.decision }),
                ...(effect.request.answers === undefined
                  ? {}
                  : { answers: effect.request.answers }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "provider-thread.rollback":
            return checkpointRollback
              .execute({
                threadId: effect.threadId,
                providerThreadId: effect.request.providerThreadId,
                checkpointId: effect.request.checkpointId,
                commandId: effect.commandId,
                scopeId: effect.request.scopeId,
                ...(effect.request.restoreFiles === undefined
                  ? {}
                  : { restoreFiles: effect.request.restoreFiles }),
              })
              .pipe(
                Effect.tap(() =>
                  threads.dispatch({
                    type: "checkpoint.rollback.complete",
                    commandId: CommandId.make(`${effect.commandId}:rollback-completed`),
                    threadId: effect.threadId,
                    requestId: effect.commandId,
                  }),
                ),
                // The last failed attempt tells waiting clients it failed,
                // instead of leaving them to time out. Clients get a fixed
                // message; the worker logs the full cause for each attempt.
                Effect.tapCause((cause) =>
                  willRetry || Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : threads
                        .dispatch({
                          type: "checkpoint.rollback.fail",
                          commandId: CommandId.make(`${effect.commandId}:rollback-failed`),
                          threadId: effect.threadId,
                          requestId: effect.commandId,
                          message: CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
                        })
                        .pipe(
                          Effect.catchCause((recordCause) =>
                            Effect.logWarning("Failed to record rollback failure", {
                              effectId: effect.id,
                              cause: recordCause,
                            }),
                          ),
                        ),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "checkpoint.capture":
            return runFinalization
              .finalize({
                threadId: effect.threadId,
                runId: effect.request.runId,
                scopeId: effect.request.scopeId,
              })
              .pipe(
                // SCIENT-FORK:START checkpoint-capture-final-attempt
                Effect.provideService(CheckpointCaptureFinalAttempt, !willRetry),
                // SCIENT-FORK:END checkpoint-capture-final-attempt
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "terminal.cleanup":
            return resourceCleanup.cleanupTerminals(effect.threadId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "attachment.rollback-prune":
            return rollbackPrune.execute(effect.threadId, effect.request).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "attachment.cleanup":
            return resourceCleanup.cleanupAttachments(effect.request.attachmentIds).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationEffectExecutionError({
                    effectId: effect.id,
                    effectType: effect.request.type,
                    cause,
                  }),
              ),
            );
          case "thread-title.generate":
            return threadTitleRegeneration
              .execute({
                threadId: effect.threadId,
                requestId: effect.commandId,
                kind: effect.request.kind,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
          case "delegated-tasks.stop":
            return threads
              .stopDelegatedTasks({
                threadId: effect.threadId,
                commandId: effect.commandId,
                reason: effect.request.reason,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestrationEffectExecutionError({
                      effectId: effect.id,
                      effectType: effect.request.type,
                      cause,
                    }),
                ),
              );
        }
      },
    });
  }),
);

export class OrchestrationEffectWorkerError extends Schema.TaggedError<OrchestrationEffectWorkerError>()(
  "OrchestrationEffectWorkerError",
  {
    operation: Schema.String,
    effectId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isOrchestrationEffectWorkerError = Schema.is(OrchestrationEffectWorkerError);

export interface OrchestrationEffectWorkerV2Shape {
  readonly awaitWork: Effect.Effect<void>;
  readonly runOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly runRecoveryOnce: Effect.Effect<boolean, OrchestrationEffectWorkerError>;
  readonly nextClaimableAt: Effect.Effect<
    Option.Option<DateTime.Utc>,
    OrchestrationEffectWorkerError
  >;
  readonly drain: (maxEffects?: number) => Effect.Effect<number, OrchestrationEffectWorkerError>;
}

export class OrchestrationEffectWorkerV2 extends Context.Service<
  OrchestrationEffectWorkerV2,
  OrchestrationEffectWorkerV2Shape
>()("t3/orchestration-v2/EffectWorker/OrchestrationEffectWorkerV2") {}

export interface OrchestrationEffectWorkerOptions {
  readonly workerId?: string;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
}

export const layerWithOptions = (
  options: OrchestrationEffectWorkerOptions = {},
): Layer.Layer<
  OrchestrationEffectWorkerV2,
  never,
  EffectOutbox.EffectOutboxV2 | OrchestrationEffectExecutorV2
> =>
  Layer.effect(
    OrchestrationEffectWorkerV2,
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const executor = yield* OrchestrationEffectExecutorV2;
      const workerId = options.workerId ?? `orchestration-v2:${process.pid}`;
      const leaseDurationMs = Math.max(1, options.leaseDurationMs ?? 30_000);
      const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
      const wasCancelled = (effectId: string) =>
        outbox.get(effectId).pipe(
          Effect.map(
            Option.match({
              onNone: () => false,
              onSome: (effect) => effect.status === "cancelled",
            }),
          ),
        );
      const requeueClaim = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : outbox
              .retry({
                effectId: effect.id,
                workerId,
                error: `Worker failed before settling the claimed effect: ${Cause.pretty(cause)}`,
                delayMs: 0,
              })
              .pipe(
                Effect.flatMap((requeued) =>
                  requeued
                    ? Effect.logWarning("Requeued effect after unexpected worker failure", {
                        effectId: effect.id,
                        effectType: effect.request.type,
                      })
                    : Effect.logWarning("Could not requeue effect after worker lost its lease", {
                        effectId: effect.id,
                        effectType: effect.request.type,
                      }),
                ),
                Effect.catchCause((requeueCause) =>
                  Effect.logError("Failed to requeue effect after unexpected worker failure", {
                    effectId: effect.id,
                    effectType: effect.request.type,
                    error: Cause.pretty(requeueCause),
                  }),
                ),
              );
      const terminalizeClaim = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        return outbox
          .fail({
            effectId: effect.id,
            workerId,
            error: `Worker failed to settle a process-bound effect after execution started: ${Cause.pretty(cause)}`,
          })
          .pipe(
            Effect.flatMap((failed) =>
              failed
                ? Effect.logError("Terminalized process-bound effect after settlement failure", {
                    effectId: effect.id,
                    effectType: effect.request.type,
                  })
                : Effect.logWarning(
                    "Could not terminalize process-bound effect after worker lost its lease",
                    {
                      effectId: effect.id,
                      effectType: effect.request.type,
                    },
                  ),
            ),
            Effect.catchCause((failCause) =>
              Effect.logError(
                "Failed to terminalize process-bound effect after settlement failure",
                {
                  effectId: effect.id,
                  effectType: effect.request.type,
                  error: Cause.pretty(failCause),
                },
              ),
            ),
          );
      };
      const recoverPostSuccessSettlement = (
        effect: EffectOutbox.OrchestrationEffectV2,
        cause: Cause.Cause<unknown>,
      ) =>
        EffectOutbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS.some(
          (effectType) => effectType === effect.request.type,
        )
          ? requeueClaim(effect, cause)
          : terminalizeClaim(effect, cause);

      const runOnce = (excludeRestartContinuations = false) =>
        Effect.gen(function* () {
          const claimExit = yield* Effect.exit(
            outbox.claimNext({ workerId, leaseDurationMs, excludeRestartContinuations }),
          );
          yield* increment(orchestrationEffectClaimsTotal, {
            result: Exit.isFailure(claimExit)
              ? "error"
              : Option.isNone(claimExit.value)
                ? "empty"
                : "claimed",
          });
          if (Exit.isFailure(claimExit)) return yield* Effect.failCause(claimExit.cause);
          const claimed = claimExit.value;
          if (Option.isNone(claimed)) {
            return false;
          }
          const effect = claimed.value;
          // Arm the process-local cancellation signal before re-reading durable
          // state. A cancellation that commits after the row read has begun can
          // then still win the execution race instead of falling into the gap
          // between the read and signal registration.
          const cancellation = outbox
            .awaitCancellation(effect.id)
            .pipe(Effect.as("cancelled" as const));
          const cancelledBeforeExecution = yield* Effect.gen(function* () {
            const claimedAt = DateTime.toEpochMillis(yield* DateTime.now);
            const eligibleAt = Math.max(
              DateTime.toEpochMillis(DateTime.makeUnsafe(effect.createdAt)),
              DateTime.toEpochMillis(DateTime.makeUnsafe(effect.availableAt)),
            );
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationEffectQueueWait,
                metricAttributes({ effect_type: effect.request.type }),
              ),
              Duration.millis(Math.max(0, claimedAt - eligibleAt)),
            );
            // Cancellation can commit after the durable claim but before the
            // process-local Deferred is registered. Re-read the authoritative row
            // once before starting external work; later cancellations use the
            // Deferred raced below.
            if (yield* wasCancelled(effect.id)) {
              yield* outbox.clearCancellation(effect.id);
              return true;
            }
            return false;
          }).pipe(Effect.onError((cause) => requeueClaim(effect, cause)));
          if (cancelledBeforeExecution) return true;

          const execution = executor
            .execute(effect, { willRetry: effect.attemptCount < maxAttempts })
            .pipe(Effect.as("executed" as const));
          const exit = yield* Effect.exit(Effect.raceFirst(execution, cancellation)).pipe(
            Effect.ensuring(outbox.clearCancellation(effect.id)),
          );
          if (Exit.isSuccess(exit) && exit.value === "cancelled") {
            return true;
          }
          if (Exit.isSuccess(exit)) {
            return yield* Effect.gen(function* () {
              const completed = yield* outbox.succeed({ effectId: effect.id, workerId });
              if (!completed) {
                if (yield* wasCancelled(effect.id)) return true;
                return yield* new OrchestrationEffectWorkerError({
                  operation: "complete",
                  effectId: effect.id,
                  cause: "The worker no longer owns the effect lease.",
                });
              }
              return true;
            }).pipe(Effect.onError((cause) => recoverPostSuccessSettlement(effect, cause)));
          }

          const failure = Cause.findErrorOption(exit.cause);
          const deferredDroidSteer =
            Option.isSome(failure) && failure.value.cause instanceof DroidSteerDeferred;
          const uncertainDroidSteer =
            Option.isSome(failure) && failure.value.cause instanceof DroidSteerUncertain;
          const awaitingNativeReceipt =
            effect.request.type === "provider-run.interrupt" &&
            Option.isSome(failure) &&
            isProviderRunInterruptError(failure.value.cause) &&
            failure.value.cause.reason === "receipt_pending";
          // SCIENT-FORK:START checkpoint-capture-final-attempt
          const checkpointSettlementPending =
            Option.isSome(failure) && isCheckpointSettlementPending(failure.value);
          // SCIENT-FORK:END checkpoint-capture-final-attempt
          const error = Cause.pretty(exit.cause);
          const nonRetryable = isNonRetryableProviderTurnControlFailure(effect.request.type, error);
          yield* deferredDroidSteer
            ? Effect.void
            : Effect.logWarning("Orchestration effect execution failed", {
                effectId: effect.id,
                effectType: effect.request.type,
                attemptCount: effect.attemptCount,
                nonRetryable,
                error,
              });
          // Prefer succeed for terminal interrupt races so the outbox does not
          // keep a failed interrupt around; fail only when we must not retry.
          const updated = nonRetryable
            ? yield* outbox
                .succeed({ effectId: effect.id, workerId })
                .pipe(Effect.onError((cause) => terminalizeClaim(effect, cause)))
            : uncertainDroidSteer ||
                (effect.attemptCount >= maxAttempts &&
                  !awaitingNativeReceipt &&
                  // SCIENT-FORK:START checkpoint-capture-final-attempt
                  !checkpointSettlementPending &&
                  // SCIENT-FORK:END checkpoint-capture-final-attempt
                  !deferredDroidSteer &&
                  effect.request.type !== "attachment.rollback-prune")
              ? yield* outbox
                  .fail({ effectId: effect.id, workerId, error })
                  .pipe(Effect.onError((cause) => terminalizeClaim(effect, cause)))
              : yield* outbox
                  .retry({
                    effectId: effect.id,
                    workerId,
                    error,
                    delayMs: deferredDroidSteer
                      ? 100
                      : Math.min(30_000, 100 * 2 ** Math.max(0, effect.attemptCount - 1)),
                  })
                  .pipe(Effect.onError((cause) => requeueClaim(effect, cause)));
          if (!updated) {
            if (yield* wasCancelled(effect.id)) return true;
            return yield* new OrchestrationEffectWorkerError({
              operation: "reschedule",
              effectId: effect.id,
              cause: "The worker no longer owns the effect lease.",
            });
          }
          return true;
        }).pipe(
          Effect.mapError((cause) =>
            isOrchestrationEffectWorkerError(cause)
              ? cause
              : new OrchestrationEffectWorkerError({ operation: "run", cause }),
          ),
        );

      return OrchestrationEffectWorkerV2.of({
        awaitWork: outbox.awaitAvailable,
        runOnce: runOnce(),
        runRecoveryOnce: runOnce(true),
        nextClaimableAt: outbox.nextClaimableAt.pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationEffectWorkerError({
                operation: "next-claimable",
                cause,
              }),
          ),
        ),
        drain: (maxEffects = Number.MAX_SAFE_INTEGER) =>
          Effect.gen(function* () {
            let completed = 0;
            while (completed < maxEffects && (yield* runOnce())) {
              completed += 1;
            }
            return completed;
          }),
      });
    }),
  );

export const layer = layerWithOptions();

export interface OrchestrationEffectDaemonOptions {
  readonly concurrency?: number;
  readonly livenessPollIntervalMs?: number;
}

const DEFAULT_EFFECT_WORKER_CONCURRENCY = 4;
const DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS = 30_000;

export const runDaemonWithOptions = (options: OrchestrationEffectDaemonOptions = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* OrchestrationEffectWorkerV2;
      const requestedConcurrency = options.concurrency ?? DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const concurrency = Number.isFinite(requestedConcurrency)
        ? Math.max(1, Math.floor(requestedConcurrency))
        : DEFAULT_EFFECT_WORKER_CONCURRENCY;
      const requestedLivenessPollIntervalMs =
        options.livenessPollIntervalMs ?? DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      const livenessPollIntervalMs = Number.isFinite(requestedLivenessPollIntervalMs)
        ? Math.max(1, Math.floor(requestedLivenessPollIntervalMs))
        : DEFAULT_EFFECT_WORKER_LIVENESS_POLL_INTERVAL_MS;
      // Post-commit notifications are the low-latency path. `availableAt` is the
      // durable retry schedule, and the long liveness poll only recovers from a
      // missed in-process notification or work inserted by another process.
      const runWorker = Effect.gen(function* () {
        while (true) {
          const outcome = yield* worker.runOnce.pipe(
            Effect.map((worked) => (worked ? ("worked" as const) : ("idle" as const))),
            Effect.catchCause((cause) =>
              Effect.logWarning("Orchestration effect worker failed", cause).pipe(
                Effect.as("failed" as const),
              ),
            ),
          );
          if (outcome === "worked") {
            yield* Effect.yieldNow;
            continue;
          }
          if (outcome === "failed") {
            // A due row can remain visible when a claim UPDATE fails. Do not
            // feed that past deadline back into the scheduler and retry at the
            // one-millisecond floor; let transient database failures cool off.
            yield* Effect.sleep(Duration.millis(Math.min(1_000, livenessPollIntervalMs)));
            continue;
          }

          const nextClaimableAt = yield* worker.nextClaimableAt.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Failed to read the next orchestration effect deadline",
                cause,
              ).pipe(Effect.as(Option.none<DateTime.Utc>())),
            ),
          );
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const sleepMs = Option.match(nextClaimableAt, {
            onNone: () => livenessPollIntervalMs,
            onSome: (availableAt) => {
              const untilAvailable = DateTime.toEpochMillis(availableAt) - now;
              return Math.min(livenessPollIntervalMs, untilAvailable > 0 ? untilAvailable : 25);
            },
          });
          yield* Effect.raceFirst(
            worker.awaitWork.pipe(Effect.as("notified" as const)),
            Effect.sleep(Duration.millis(sleepMs)).pipe(Effect.as("scheduled" as const)),
          );
        }
      });

      return yield* Effect.all(
        Array.from({ length: concurrency }, () => runWorker),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }),
  );

export const runDaemon = runDaemonWithOptions();

const layerDaemon: Layer.Layer<never, never, OrchestrationEffectWorkerV2> = Layer.effectDiscard(
  runDaemon.pipe(Effect.forkScoped),
);
