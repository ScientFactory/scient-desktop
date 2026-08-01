import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";

import {
  makeScientOperationAuthority,
  SCIENT_OPERATION_DEFINITIONS,
  type ScientOperationCapability,
  type ScientOperationResultReceipt,
} from "../authority.ts";
import type { ScientOperationExecutionContext } from "../Services/ScientOperationExecutor.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import type {
  ScientOperationClaimDecision,
  ScientOperationReceiptRepositoryShape,
} from "../../persistence/Services/ScientOperationReceipts.ts";
import { makeEphemeralScientOperationExecutor } from "./ScientOperationExecutor.ts";

class AdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const NOW = 1_800_000_000_000;

function authority(capabilities: ReadonlyArray<ScientOperationCapability>) {
  return makeScientOperationAuthority({
    authorityId: "authority-1",
    generation: "generation-1",
    actor: {
      kind: "provider-thread",
      threadId: "thread-caller",
      provider: "claudeAgent",
      sessionKey: "session-1",
    },
    projectIds: ["project-1"],
    capabilities,
    issuedAt: NOW - 1,
    expiresAt: null,
    revokedAt: null,
  });
}

function baseInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    authority: authority(["thread:read"]),
    operation: "thread.read" as const,
    projectId: "project-1",
    ingress: "provider-gateway" as const,
    domainInput: { threadId: " target-thread " },
    admit: Effect.succeed("admitted"),
    execute: (input: Readonly<Record<string, unknown>>) => Effect.succeed(input),
    releaseRead: () => Effect.void,
    releaseReplay: () => Effect.void,
    runTransactionalWrite: <A>(effect: Effect.Effect<A>) => effect,
    revocationFence: Effect.never as Effect.Effect<never, AdapterError>,
    resultErrorCode: () => null,
    ...overrides,
  };
}

function fakeRepository(input?: {
  readonly claim?: ScientOperationReceiptRepositoryShape["claim"];
  readonly finish?: ScientOperationReceiptRepositoryShape["finish"];
  readonly finalizeReplayAttempt?: ScientOperationReceiptRepositoryShape["finalizeReplayAttempt"];
}): ScientOperationReceiptRepositoryShape {
  return {
    ownerId: "test-owner",
    acquireOwner: () => Effect.void,
    heartbeatOwner: () => Effect.void,
    releaseOwner: () => Effect.void,
    claim: input?.claim ?? (() => Effect.succeed({ kind: "acquired" })),
    finish: input?.finish ?? (() => Effect.void),
    recoverInterrupted: () => Effect.succeed(0),
    finalizeReplayAttempt: input?.finalizeReplayAttempt ?? (() => Effect.void),
    listUncertainIntents: () => Effect.succeed([]),
    reconcileIntent: () =>
      Effect.die(new Error("reconcileIntent is not used by this executor test repository")),
    getByClaimKey: () => Effect.succeed(Option.none()),
    pruneTerminal: () => Effect.succeed(0),
  };
}

const durableSendInput = (overrides: Partial<Record<string, unknown>> = {}) =>
  baseInput({
    authority: authority(["thread:drive"]),
    operation: "thread.message.send",
    semanticIdempotencyScope: {
      kind: "provider-turn" as const,
      provider: "claudeAgent",
      callerThreadId: "thread-caller",
      callerTurnId: "turn-1",
    },
    domainInput: {
      threadId: "thread-target",
      message: "hello",
      requestId: "request-1",
    },
    execute: () => Effect.succeed({ threadId: "thread-target", dispatched: "queue" as const }),
    durableReplay: {
      encode: () => ({
        kind: "thread.message.send.v1" as const,
        threadId: "thread-target",
        dispatched: "queue" as const,
      }),
      decode: (replay: { readonly threadId: string; readonly dispatched: "queue" | "steer" }) => ({
        threadId: replay.threadId,
        dispatched: replay.dispatched,
        deduplicated: true,
      }),
    },
    prepareDurableIntent: (
      _canonicalInput: Readonly<Record<string, unknown>>,
      envelope: { readonly idempotency: { readonly claimKey: string } },
    ) => ({
      effect: {
        kind: "orchestration-command" as const,
        identity: `scient-operation:v2:${envelope.idempotency.claimKey}:thread-send`,
      },
      expectedAggregateKind: "thread" as const,
      expectedAggregateId: "thread-target",
      replayResult: {
        kind: "thread.message.send.v1" as const,
        threadId: "thread-target",
        dispatched: "queue" as const,
      },
    }),
    ...overrides,
  });

describe("ScientOperationExecutor", () => {
  it("owns canonical input, authorization, request identity, execution, and receipts", async () => {
    const receipts: ScientOperationResultReceipt[] = [];
    let nextId = 0;
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      randomId: () => `id-${++nextId}`,
      recordReceipt: (receipt) => receipts.push(receipt),
    });

    const outcome = await Effect.runPromise(executor.execute(baseInput()));

    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished" || outcome.error !== null) throw new Error("unexpected");
    expect(outcome.result).toEqual({ threadId: "target-thread" });
    expect(outcome.receipt).toMatchObject({
      receiptId: "scient-receipt:id-2",
      operationId: "scient-operation:id-1",
      operation: "thread.read",
      outcome: "succeeded",
      errorCode: null,
    });
    expect(receipts).toEqual([outcome.receipt]);
  });

  it("rejects invalid canonical input before admission or execution", async () => {
    let admitted = false;
    let executed = false;
    const executor = makeEphemeralScientOperationExecutor({ now: () => NOW });

    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          domainInput: {},
          admit: Effect.sync(() => {
            admitted = true;
            return "admitted";
          }),
          execute: () => {
            executed = true;
            return Effect.succeed({});
          },
        }),
      ),
    );

    expect(outcome.kind).toBe("input-rejected");
    expect(admitted).toBe(false);
    expect(executed).toBe(false);
  });

  it("rejects missing capability before host admission", async () => {
    let admitted = false;
    const executor = makeEphemeralScientOperationExecutor({ now: () => NOW });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          authority: authority(["thread:drive"]),
          admit: Effect.sync(() => {
            admitted = true;
            return "admitted";
          }),
        }),
      ),
    );

    expect(outcome).toMatchObject({
      kind: "authority-rejected",
      decision: { allow: false, code: "capability_denied" },
    });
    expect(admitted).toBe(false);
  });

  it("ignores a structurally forged definition and resolves policy from the registry key", async () => {
    let executed = false;
    const executor = makeEphemeralScientOperationExecutor({ now: () => NOW });
    const forgedInput = {
      ...baseInput({
        authority: authority(["thread:drive"]),
        execute: () => {
          executed = true;
          return Effect.succeed({});
        },
      }),
      // A future JavaScript caller can still attach extra structural fields;
      // the executor must never consult them.
      definition: SCIENT_OPERATION_DEFINITIONS["thread.message.send"],
    };

    const outcome = await Effect.runPromise(executor.execute(forgedInput));

    expect(outcome).toMatchObject({
      kind: "authority-rejected",
      decision: { code: "capability_denied" },
    });
    expect(executed).toBe(false);
  });

  it("fails irreversible external effects closed before admission or execution", async () => {
    let admitted = false;
    let executed = false;
    const executor = makeEphemeralScientOperationExecutor({ now: () => NOW });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          operation: "browser.action",
          authority: authority(["browser:action"]),
          admit: Effect.sync(() => {
            admitted = true;
            return "admitted";
          }),
          execute: () => {
            executed = true;
            return Effect.succeed({});
          },
        }),
      ),
    );

    expect(outcome).toMatchObject({
      kind: "execution-rejected",
      code: "operation_not_available",
    });
    expect(admitted).toBe(false);
    expect(executed).toBe(false);
  });

  it("returns a typed host-admission rejection without running the effect", async () => {
    let executed = false;
    const executor = makeEphemeralScientOperationExecutor({ now: () => NOW });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          admit: Effect.fail(new AdapterError("caller_session_inactive")),
          execute: () => {
            executed = true;
            return Effect.succeed({});
          },
        }),
      ),
    );

    expect(outcome.kind).toBe("admission-rejected");
    expect(executed).toBe(false);
  });

  it("races a read against revocation and records a failed receipt", async () => {
    const receipts: ScientOperationResultReceipt[] = [];
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      recordReceipt: (receipt) => receipts.push(receipt),
    });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          execute: () => Effect.never,
          revocationFence: Effect.fail(new AdapterError("caller_session_inactive")),
        }),
      ),
    );

    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") throw new Error("unexpected");
    expect(outcome.error).toMatchObject({ code: "caller_session_inactive" });
    expect(outcome.receipt).toMatchObject({
      outcome: "failed",
      errorCode: "caller_session_inactive",
    });
    expect(receipts).toHaveLength(1);
  });

  it("rechecks read authority at release and never releases a stale result", async () => {
    const executor = makeEphemeralScientOperationExecutor({ now: () => NOW });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          execute: () => Effect.succeed({ secret: "stale" }),
          releaseRead: () => Effect.fail(new AdapterError("caller_session_inactive")),
        }),
      ),
    );

    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") throw new Error("unexpected");
    expect(outcome.result).toBeNull();
    expect(outcome.error).toMatchObject({ code: "caller_session_inactive" });
  });

  it("delegates transactional writes to the host fence and records effects", async () => {
    let transactionEntered = false;
    const executor = makeEphemeralScientOperationExecutor({ now: () => NOW });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          authority: authority(["thread:drive"]),
          operation: "thread.message.send",
          semanticIdempotencyScope: {
            kind: "provider-turn",
            provider: "claudeAgent",
            callerThreadId: "thread-caller",
            callerTurnId: "turn-1",
          },
          domainInput: {
            threadId: "thread-target",
            message: "hello",
            requestId: "request-1",
          },
          runTransactionalWrite: <A>(effect: Effect.Effect<A>) => {
            transactionEntered = true;
            return effect;
          },
          execute: (
            _input: Readonly<Record<string, unknown>>,
            context: ScientOperationExecutionContext<string>,
          ) => {
            context.recordEffect({
              kind: "orchestration-command",
              identity: "command-1",
            });
            return Effect.succeed({ ok: true });
          },
        }),
      ),
    );

    expect(transactionEntered).toBe(true);
    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") throw new Error("unexpected");
    expect(outcome.receipt.effects).toEqual([
      { kind: "orchestration-command", identity: "command-1" },
    ]);
  });

  it("classifies an authored uncertain result and ignores observer failure", async () => {
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      recordReceipt: () => {
        throw new Error("diagnostic sink unavailable");
      },
    });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          resultErrorCode: () => "operation_outcome_uncertain",
          execute: () => Effect.succeed({ isError: true }),
        }),
      ),
    );

    expect(outcome.kind).toBe("finished");
    if (outcome.kind !== "finished") throw new Error("unexpected");
    expect(outcome.receipt).toMatchObject({
      outcome: "uncertain/reconciliation-required",
      errorCode: "operation_outcome_uncertain",
    });
  });

  it("fails a semantic operation before claim and effect when no durable replay exists", async () => {
    let claimed = false;
    let executed = false;
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      receiptRepository: fakeRepository({
        claim: () => {
          claimed = true;
          return Effect.succeed({ kind: "acquired" });
        },
      }),
    });
    const outcome = await Effect.runPromise(
      executor.execute(
        durableSendInput({
          durableReplay: undefined,
          execute: () => {
            executed = true;
            return Effect.succeed({});
          },
        }),
      ),
    );

    expect(outcome).toMatchObject({
      kind: "durability-rejected",
      code: "operation_receipt_unavailable",
    });
    expect(claimed).toBe(false);
    expect(executed).toBe(false);
  });

  it("serializes concurrent semantic retries and replays one durable result", async () => {
    let executes = 0;
    const replayDispositions: string[] = [];
    let failFinalization = false;
    let stored:
      | {
          readonly decision: Extract<ScientOperationClaimDecision, { readonly kind: "replay" }>;
        }
      | undefined;
    const repository = fakeRepository({
      claim: () => Effect.sync(() => stored?.decision ?? ({ kind: "acquired" } as const)),
      finish: ({ envelope, receipt, replayResult }) =>
        Effect.sync(() => {
          const { authorityGeneration: _authorityGeneration, ...persisted } = receipt;
          if (replayResult === null) throw new Error("expected safe replay");
          stored = {
            decision: {
              kind: "replay",
              status: "succeeded",
              attempt: {
                operationId: envelope.operationId,
                claimKey: envelope.idempotency.claimKey,
                attemptSequence: 2,
              },
              receipt: {
                ...persisted,
                authorityGenerationHash: "sha256:test",
                claimKey: envelope.idempotency.claimKey,
                receiptSequence: 1,
                reconcilesReceiptId: null,
                attribution: {
                  actorKind: "provider-thread",
                  ingress: "provider-gateway",
                  parentOperationHash: null,
                  authorityIdHash: "sha256:authority",
                  actorRefHash: "sha256:actor",
                  providerThreadHash: "sha256:v1:provider-thread",
                  provider: "claudeAgent",
                  providerTurnHash: "sha256:v1:provider-turn",
                  automationHash: null,
                  automationRunHash: null,
                  integrationHash: null,
                  manualUserHash: null,
                },
              },
              replayResult,
            },
          };
        }),
      finalizeReplayAttempt: (attempt) =>
        failFinalization
          ? Effect.fail(
              new PersistenceSqlError({
                operation: "finalizeReplayAttempt",
                detail: "database unavailable",
              }),
            )
          : Effect.sync(() => {
              replayDispositions.push(attempt.disposition);
            }),
    });
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      receiptRepository: repository,
    });
    const input = durableSendInput({
      execute: () =>
        Effect.promise(async () => {
          executes += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { threadId: "thread-target", dispatched: "queue" as const };
        }),
    });

    const [first, second] = await Promise.all([
      Effect.runPromise(executor.execute(input)),
      Effect.runPromise(executor.execute(input)),
    ]);

    expect(executes).toBe(1);
    expect([first.kind, second.kind].toSorted()).toEqual(["finished", "replayed"]);
    expect(replayDispositions).toEqual(["allowed"]);

    const denied = await Effect.runPromise(
      executor.execute(
        durableSendInput({
          releaseReplay: () => Effect.fail(new AdapterError("caller_turn_inactive")),
        }),
      ),
    );
    expect(denied.kind).toBe("admission-rejected");
    expect(replayDispositions).toEqual(["allowed", "denied"]);

    const reconstructionFailed = await Effect.runPromise(
      executor.execute(
        durableSendInput({
          durableReplay: {
            encode: () => ({
              kind: "thread.message.send.v1" as const,
              threadId: "thread-target",
              dispatched: "queue" as const,
            }),
            decode: () => {
              throw new Error("invalid replay fixture");
            },
          },
        }),
      ),
    );
    expect(reconstructionFailed).toMatchObject({
      kind: "durability-rejected",
      code: "operation_receipt_unavailable",
    });
    expect(replayDispositions).toEqual(["allowed", "denied", "reconstruction-failed"]);

    failFinalization = true;
    const withheld = await Effect.runPromise(executor.execute(input));
    expect(withheld).toMatchObject({
      kind: "durability-rejected",
      code: "operation_receipt_unavailable",
    });
  });

  it("reports uncertainty when safe replay encoding fails after the effect", async () => {
    let persistedOutcome: string | undefined;
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      receiptRepository: fakeRepository({
        finish: ({ receipt }) =>
          Effect.sync(() => {
            persistedOutcome = receipt.outcome;
          }),
      }),
    });
    const outcome = await Effect.runPromise(
      executor.execute(
        durableSendInput({
          durableReplay: {
            encode: () => {
              throw new Error("codec defect");
            },
            decode: () => ({ ok: true }),
          },
        }),
      ),
    );

    expect(outcome).toMatchObject({
      kind: "durability-rejected",
      code: "operation_outcome_uncertain",
    });
    expect(persistedOutcome).toBe("uncertain/reconciliation-required");
  });

  it("fails closed before effects when durable claiming fails", async () => {
    let executed = false;
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      receiptRepository: fakeRepository({
        claim: () =>
          Effect.fail(
            new PersistenceSqlError({ operation: "claim", detail: "database unavailable" }),
          ),
      }),
    });
    const outcome = await Effect.runPromise(
      executor.execute(
        durableSendInput({
          execute: () => {
            executed = true;
            return Effect.succeed({});
          },
        }),
      ),
    );

    expect(outcome).toMatchObject({
      kind: "durability-rejected",
      code: "operation_receipt_unavailable",
    });
    expect(executed).toBe(false);
  });

  it("reports uncertainty when terminal persistence fails after the effect", async () => {
    let executed = false;
    const executor = makeEphemeralScientOperationExecutor({
      now: () => NOW,
      receiptRepository: fakeRepository({
        finish: () =>
          Effect.fail(
            new PersistenceSqlError({ operation: "finish", detail: "database unavailable" }),
          ),
      }),
    });
    const outcome = await Effect.runPromise(
      executor.execute(
        durableSendInput({
          execute: () => {
            executed = true;
            return Effect.succeed({ threadId: "thread-target", dispatched: "queue" });
          },
        }),
      ),
    );

    expect(executed).toBe(true);
    expect(outcome).toMatchObject({
      kind: "durability-rejected",
      code: "operation_outcome_uncertain",
    });
  });
});
