import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  makeScientOperationAuthority,
  SCIENT_OPERATION_DEFINITIONS,
  type ScientOperationCapability,
  type ScientOperationResultReceipt,
} from "../authority.ts";
import type { ScientOperationExecutionContext } from "../Services/ScientOperationExecutor.ts";
import { makeScientOperationExecutor } from "./ScientOperationExecutor.ts";

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
    runTransactionalWrite: <A>(effect: Effect.Effect<A>) => effect,
    revocationFence: Effect.never as Effect.Effect<never, AdapterError>,
    resultErrorCode: () => null,
    ...overrides,
  };
}

describe("ScientOperationExecutor", () => {
  it("owns canonical input, authorization, request identity, execution, and receipts", async () => {
    const receipts: ScientOperationResultReceipt[] = [];
    let nextId = 0;
    const executor = makeScientOperationExecutor({
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
    const executor = makeScientOperationExecutor({ now: () => NOW });

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
    const executor = makeScientOperationExecutor({ now: () => NOW });
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
    const executor = makeScientOperationExecutor({ now: () => NOW });
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
    const executor = makeScientOperationExecutor({ now: () => NOW });
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
    const executor = makeScientOperationExecutor({ now: () => NOW });
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
    const executor = makeScientOperationExecutor({
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
    const executor = makeScientOperationExecutor({ now: () => NOW });
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
    const executor = makeScientOperationExecutor({ now: () => NOW });
    const outcome = await Effect.runPromise(
      executor.execute(
        baseInput({
          authority: authority(["thread:drive"]),
          operation: "thread.message.send",
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
    const executor = makeScientOperationExecutor({
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
});
