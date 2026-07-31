/** Live host-neutral Scient operation executor. */
import { createHash, randomUUID } from "node:crypto";

import { CommandId } from "@synara/contracts";
import { Duration, Effect, Layer, Option, Schedule } from "effect";

import {
  beginScientOperation,
  completeScientOperation,
  SCIENT_OPERATION_DEFINITIONS,
  ScientOperationInputError,
  type ScientOperationEffectIdentity,
} from "../authority.ts";
import {
  ScientOperationExecutor,
  type ScientOperationExecutionInput,
  type ScientOperationExecutionOutcome,
  type ScientOperationExecutorShape,
} from "../Services/ScientOperationExecutor.ts";
import {
  ScientOperationReceiptRepository,
  type ScientOperationReceiptRepositoryShape,
} from "../../persistence/Services/ScientOperationReceipts.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const EXECUTOR_OWNER_STALE_MS = 30_000;
const EXECUTOR_OWNER_HEARTBEAT_MS = 10_000;
const INTENT_RECONCILIATION_INTERVAL_MS = 5_000;
const INTENT_RECONCILIATION_BATCH = 100;

export function reconcileUncertainScientOperationIntents(input: {
  readonly receiptRepository: ScientOperationReceiptRepositoryShape;
  readonly commandReceiptRepository: OrchestrationCommandReceiptRepositoryShape;
  readonly now?: () => number;
  readonly randomId?: () => string;
  /** Startup must fail closed; periodic retries may preserve uncertainty. */
  readonly strict?: boolean;
}) {
  const now = input.now ?? Date.now;
  const randomId = input.randomId ?? randomUUID;
  return input.receiptRepository.listUncertainIntents({ limit: INTENT_RECONCILIATION_BATCH }).pipe(
    Effect.flatMap((intents) =>
      Effect.forEach(
        intents,
        (intent) =>
          input.commandReceiptRepository
            .getByCommandId({ commandId: CommandId.makeUnsafe(intent.effect.identity) })
            .pipe(
              Effect.matchEffect({
                // A lookup failure is ambiguous. Leave the operation uncertain
                // so the bounded periodic pass can retry without guessing.
                onFailure: (error) =>
                  input.strict === true
                    ? Effect.fail(error)
                    : Effect.logWarning(
                        "Scient operation reconciliation command-receipt lookup failed; leaving intent uncertain.",
                      ).pipe(Effect.as(false)),
                onSuccess: Option.match({
                  onNone: () => Effect.succeed(false),
                  onSome: (commandReceipt) => {
                    if (
                      commandReceipt.aggregateKind !== intent.expectedAggregateKind ||
                      commandReceipt.aggregateId !== intent.expectedAggregateId ||
                      (commandReceipt.status === "accepted" &&
                        (commandReceipt.error !== null || commandReceipt.resultSequence <= 0)) ||
                      (commandReceipt.status === "rejected" && commandReceipt.resultSequence < 0)
                    ) {
                      return Effect.logWarning(
                        "Scient operation reconciliation found a command receipt that does not match the trusted intent; leaving it uncertain.",
                      ).pipe(Effect.as(false));
                    }
                    return input.receiptRepository
                      .reconcileIntent({
                        claimKey: intent.claimKey,
                        receiptId: `scient-reconciliation:${randomId()}`,
                        commandId: commandReceipt.commandId,
                        aggregateKind: commandReceipt.aggregateKind,
                        aggregateId: commandReceipt.aggregateId,
                        resultSequence: commandReceipt.resultSequence,
                        commandStatus: commandReceipt.status,
                        commandError: commandReceipt.error,
                        finishedAt: now(),
                      })
                      .pipe(
                        Effect.as(true),
                        // Another pass may have reconciled first. That is safe;
                        // never reinterpret a reconciliation race as a result.
                        Effect.catch((error) =>
                          input.strict === true
                            ? Effect.fail(error)
                            : Effect.logWarning(
                                "Scient operation intent reconciliation failed; leaving it uncertain for retry.",
                              ).pipe(Effect.as(false)),
                        ),
                      );
                  },
                }),
              }),
            ),
        { concurrency: 1 },
      ),
    ),
    Effect.map((results) => results.filter(Boolean).length),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function payloadFingerprint(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/**
 * Test-only/adapter harness constructor. Omitting `receiptRepository` is
 * intentionally ephemeral and must never be used by production wiring.
 */
export function makeEphemeralScientOperationExecutor(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly recordReceipt?: (receipt: ReturnType<typeof completeScientOperation>) => void;
  readonly receiptRepository?: ScientOperationReceiptRepositoryShape;
}): ScientOperationExecutorShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  const repository = options?.receiptRepository;
  const claimTails = new Map<string, Promise<void>>();

  const withClaimLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const prior = claimTails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        claimTails.set(key, current);
        await prior;
        return { current, release };
      }),
      () => effect,
      ({ current, release }) =>
        Effect.sync(() => {
          release();
          if (claimTails.get(key) === current) claimTails.delete(key);
        }),
    );

  const execute = <Result, Admission, AdapterError>(
    input: ScientOperationExecutionInput<Result, Admission, AdapterError>,
  ): Effect.Effect<ScientOperationExecutionOutcome<Result, AdapterError>> =>
    Effect.gen(function* () {
      const definition = SCIENT_OPERATION_DEFINITIONS[input.operation];
      // A cancellation race alone cannot make an external side effect safe:
      // revocation may win after the side effect but before the adapter can
      // report its identity. F1 therefore fails this class closed. F2 may
      // enable it only after a durable pre-effect intent exists.
      if (definition.effectClass === "irreversible-external") {
        return {
          kind: "execution-rejected",
          code: "operation_not_available",
          message:
            "This irreversible Scient operation is unavailable until durable effect intent is active.",
        } as const;
      }
      const canonicalize = definition.canonicalizeInput;
      if (canonicalize === null) {
        return {
          kind: "input-rejected",
          error: new ScientOperationInputError(
            "This Scient operation does not yet have an executable domain-input contract.",
          ),
        } as const;
      }

      const canonical = yield* Effect.try({
        try: () => canonicalize(input.domainInput),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );
      if (!canonical.ok) {
        return { kind: "input-rejected", error: canonical.error } as const;
      }

      const semanticIdempotencyIdentity =
        definition.idempotencyInputField === null
          ? null
          : typeof canonical.value[definition.idempotencyInputField] === "string"
            ? (canonical.value[definition.idempotencyInputField] as string)
            : null;
      const started = beginScientOperation({
        authority: input.authority,
        definition,
        projectId: input.projectId,
        ingress: input.ingress,
        operationId: `scient-operation:${randomId()}`,
        semanticIdempotencyIdentity,
        semanticIdempotencyScope: input.semanticIdempotencyScope ?? null,
        providerAuthorizingTurnId: input.providerAuthorizingTurnId ?? null,
        payloadFingerprint: payloadFingerprint(canonical.value),
        receivedAt: now(),
      });
      if (!started.allow) {
        return { kind: "authority-rejected", decision: started.decision } as const;
      }

      const admission = yield* input.admit.pipe(
        Effect.match({
          onFailure: (error) => ({ ok: false as const, error }),
          onSuccess: (value) => ({ ok: true as const, value }),
        }),
      );
      if (!admission.ok) {
        return { kind: "admission-rejected", error: admission.error } as const;
      }
      if (
        repository !== undefined &&
        started.envelope.idempotency.mode === "semantic" &&
        (input.durableReplay === undefined || input.prepareDurableIntent === undefined)
      ) {
        return {
          kind: "durability-rejected",
          code: "operation_receipt_unavailable",
          message:
            "This semantic operation has no approved durable replay contract; no claim or effect was attempted.",
        } as const;
      }

      const runClaimed = Effect.gen(function* () {
        const preparedIntent =
          input.prepareDurableIntent === undefined
            ? null
            : yield* Effect.try({
                try: () => input.prepareDurableIntent!(canonical.value, started.envelope),
                catch: () => undefined,
              }).pipe(
                Effect.match({
                  onFailure: () => null,
                  onSuccess: (intent) => intent,
                }),
              );
        if (input.prepareDurableIntent !== undefined && preparedIntent === null) {
          return {
            kind: "durability-rejected",
            code: "operation_receipt_unavailable",
            message:
              "Scient could not construct a valid durable effect intent; no claim or effect was attempted.",
          } as const;
        }
        if (repository !== undefined) {
          const claim = yield* repository
            .claim({ envelope: started.envelope, intent: preparedIntent })
            .pipe(
              Effect.match({
                onFailure: () => ({ ok: false as const }),
                onSuccess: (decision) => ({ ok: true as const, decision }),
              }),
            );
          if (!claim.ok) {
            return {
              kind: "durability-rejected",
              code: "operation_receipt_unavailable",
              message: "Scient could not durably claim this operation; no effect was attempted.",
            } as const;
          }
          const decision = claim.decision;
          if (decision.kind === "payload-conflict") {
            return {
              kind: "durability-rejected",
              code: "idempotency_conflict",
              message: "This idempotency identity was already used with different input.",
            } as const;
          }
          if (decision.kind === "uncertain") {
            return {
              kind: "durability-rejected",
              code: "operation_outcome_uncertain",
              message:
                "A previous attempt has no trustworthy terminal outcome; reconcile it before retrying.",
            } as const;
          }
          if (decision.kind === "replay") {
            const finalizeReplay = (
              disposition: "allowed" | "denied" | "reconstruction-failed",
              errorCode: string | null,
            ) =>
              repository
                .finalizeReplayAttempt({
                  ...decision.attempt,
                  disposition,
                  errorCode,
                  finishedAt: now(),
                })
                .pipe(
                  Effect.match({
                    onFailure: () => false,
                    onSuccess: () => true,
                  }),
                );
            if (decision.replayResult === null || input.durableReplay === undefined) {
              yield* finalizeReplay("reconstruction-failed", "replay_result_unavailable");
              return {
                kind: "durability-rejected",
                code: "operation_receipt_unavailable",
                message: "The durable result cannot be safely reconstructed.",
              } as const;
            }
            const replay = yield* Effect.try({
              try: () => input.durableReplay!.decode(decision.replayResult!, canonical.value),
              catch: () => undefined,
            }).pipe(
              Effect.match({
                onFailure: () => null,
                onSuccess: (value) => value,
              }),
            );
            if (replay === null) {
              yield* finalizeReplay("reconstruction-failed", "replay_reconstruction_failed");
              return {
                kind: "durability-rejected",
                code: "operation_receipt_unavailable",
                message: "The durable result failed its operation-specific replay contract.",
              } as const;
            }
            const released = yield* input.releaseReplay(admission.value).pipe(
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: () => ({ ok: true as const }),
              }),
            );
            if (!released.ok) {
              const deniedRecorded = yield* finalizeReplay("denied", "replay_release_denied");
              if (!deniedRecorded) {
                return {
                  kind: "durability-rejected",
                  code: "operation_receipt_unavailable",
                  message:
                    "Scient denied replay release but could not durably record that decision; no replay was released.",
                } as const;
              }
              return { kind: "admission-rejected", error: released.error } as const;
            }
            const releaseRecorded = yield* finalizeReplay("allowed", null);
            if (!releaseRecorded) {
              return {
                kind: "durability-rejected",
                code: "operation_receipt_unavailable",
                message:
                  "Scient revalidated replay authority but could not terminalize its audit; no replay was released.",
              } as const;
            }
            return { kind: "replayed", result: replay, receipt: decision.receipt } as const;
          }
        }

        const effects: ScientOperationEffectIdentity[] = [];
        const handler = Effect.suspend(() =>
          input.execute(canonical.value, {
            admission: admission.value,
            envelope: started.envelope,
            recordEffect: (effect) => effects.push({ ...effect }),
          }),
        );
        const execution = yield* (
          definition.effectClass === "transactional-write"
            ? input.runTransactionalWrite(handler)
            : Effect.raceFirst(handler, input.revocationFence)
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (result) => ({ ok: true as const, result }),
          }),
        );

        let terminal:
          | {
              readonly ok: true;
              readonly result: Result;
              readonly errorCode: string | null;
            }
          | {
              readonly ok: false;
              readonly error: AdapterError;
              readonly errorCode: string;
            };
        if (!execution.ok) {
          const errorCode =
            typeof execution.error === "object" &&
            execution.error !== null &&
            "code" in execution.error &&
            typeof execution.error.code === "string"
              ? execution.error.code
              : "operation_failed";
          terminal = { ok: false, error: execution.error, errorCode };
        } else if (definition.effectClass === "read") {
          const released = yield* input.releaseRead(admission.value).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: () => ({ ok: true as const }),
            }),
          );
          if (!released.ok) {
            const errorCode =
              typeof released.error === "object" &&
              released.error !== null &&
              "code" in released.error &&
              typeof released.error.code === "string"
                ? released.error.code
                : "operation_failed";
            terminal = { ok: false, error: released.error, errorCode };
          } else {
            terminal = {
              ok: true,
              result: execution.result,
              errorCode: input.resultErrorCode(execution.result),
            };
          }
        } else {
          terminal = {
            ok: true,
            result: execution.result,
            errorCode: input.resultErrorCode(execution.result),
          };
        }

        let receipt = completeScientOperation({
          envelope: started.envelope,
          receiptId: `scient-receipt:${randomId()}`,
          finishedAt: now(),
          outcome:
            terminal.errorCode === "operation_outcome_uncertain" ||
            (terminal.errorCode !== null && effects.length > 0)
              ? "uncertain/reconciliation-required"
              : terminal.errorCode === null
                ? "succeeded"
                : "failed",
          errorCode: terminal.errorCode,
          effects,
        });

        if (repository !== undefined) {
          let replayEncodingFailed = false;
          const replayResult =
            receipt.outcome === "succeeded" && terminal.ok && input.durableReplay !== undefined
              ? yield* Effect.try({
                  try: () => input.durableReplay!.encode(terminal.result, canonical.value),
                  catch: () => undefined,
                }).pipe(
                  Effect.match({
                    onFailure: () => {
                      replayEncodingFailed = true;
                      return null;
                    },
                    onSuccess: (value) => value,
                  }),
                )
              : null;
          if (
            receipt.outcome === "succeeded" &&
            started.envelope.idempotency.mode === "semantic" &&
            replayResult === null
          ) {
            replayEncodingFailed = true;
            receipt = completeScientOperation({
              envelope: started.envelope,
              receiptId: receipt.receiptId,
              finishedAt: receipt.finishedAt,
              outcome: "uncertain/reconciliation-required",
              errorCode: "operation_replay_encoding_failed",
              effects,
            });
          }
          const persisted = yield* repository
            .finish({ envelope: started.envelope, receipt, replayResult })
            .pipe(
              Effect.match({
                onFailure: () => false,
                onSuccess: () => true,
              }),
            );
          if (!persisted || replayEncodingFailed) {
            return {
              kind: "durability-rejected",
              code: "operation_outcome_uncertain",
              message:
                "The operation ran, but Scient could not durably record its terminal outcome. Reconcile before retrying.",
            } as const;
          }
        }
        try {
          options?.recordReceipt?.(receipt);
        } catch {
          // Diagnostic observers never control the durable operation outcome.
        }
        return terminal.ok
          ? ({ kind: "finished", result: terminal.result, error: null, receipt } as const)
          : ({ kind: "finished", result: null, error: terminal.error, receipt } as const);
      });

      return yield* repository !== undefined && started.envelope.idempotency.mode === "semantic"
        ? withClaimLock(started.envelope.idempotency.claimKey, runClaimed)
        : runClaimed;
    });
  return { execute };
}

export const ScientOperationExecutorLive = Layer.effect(
  ScientOperationExecutor,
  Effect.gen(function* () {
    const receiptRepository = yield* ScientOperationReceiptRepository;
    const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
    yield* Effect.acquireRelease(
      Effect.suspend(() => {
        const attemptNow = Date.now();
        return receiptRepository.acquireOwner({
          now: attemptNow,
          staleBefore: attemptNow - EXECUTOR_OWNER_STALE_MS,
        });
      }).pipe(Effect.retry(Schedule.spaced("1 second").pipe(Schedule.take(35)))),
      () => receiptRepository.releaseOwner().pipe(Effect.ignore),
    );
    const acquiredAt = Date.now();
    yield* receiptRepository.recoverInterrupted({
      recoveredAt: acquiredAt,
    });
    yield* reconcileUncertainScientOperationIntents({
      receiptRepository,
      commandReceiptRepository,
      strict: true,
    });
    yield* receiptRepository.pruneTerminal({
      finishedBefore: acquiredAt - RECEIPT_RETENTION_MS,
      limit: 500,
    });
    yield* receiptRepository
      .heartbeatOwner({ now: Date.now() })
      .pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(EXECUTOR_OWNER_HEARTBEAT_MS))),
        Effect.forkScoped,
      );
    yield* reconcileUncertainScientOperationIntents({
      receiptRepository,
      commandReceiptRepository,
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "Scient operation periodic reconciliation pass failed; uncertain intents remain queued.",
        ),
      ),
      Effect.asVoid,
      Effect.repeat(Schedule.spaced(Duration.millis(INTENT_RECONCILIATION_INTERVAL_MS))),
      Effect.forkScoped,
    );
    return makeEphemeralScientOperationExecutor({ receiptRepository });
  }),
);

/** Explicit inert service used only while the gateway feature is disabled. */
export const ScientOperationExecutorDisabled = Layer.succeed(ScientOperationExecutor, {
  execute: () =>
    Effect.succeed({
      kind: "execution-rejected",
      code: "operation_not_available",
      message: "The Scient operation gateway is disabled.",
    }),
});
