/** Scient-owned terminal admission and per-subscription cleanup for native execution. */
import type {
  OrchestrationV2DomainEvent,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { RunExecutionServiceV2StartRootRunInput } from "../RunExecutionService.ts";

interface FinalRunWrite {
  readonly terminal: { readonly status: string };
  readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean>;
  readonly refreshAfterTurn: Effect.Effect<void>;
}

/** Share interrupt accounting across final writes for one root start. */
export const makeOwnedRunFinalizer = Effect.fnUntraced(function* <
  Final extends FinalRunWrite,
  E,
  R,
>(
  input: {
    readonly session: Pick<ProviderAdapterV2SessionRuntime, "driver" | "droidSteerTerminalHeld">;
    readonly attempt: { readonly id: RunAttemptId };
    readonly run: { readonly threadId: ThreadId };
  },
  threadDispatch: KeyedLock.KeyedLock<ThreadId>,
  writeFinalRunEvents: (final: Final) => Effect.Effect<boolean, E, R>,
) {
  // An interrupt receipt can commit even when this superseded root cannot finalize.
  const supersededInterruptResultWritten = yield* Ref.make(false);
  return Effect.fnUntraced(function* (final: Final) {
    if (
      yield* (
        input.session.droidSteerTerminalHeld?.(input.attempt.id, final.terminal.status) ??
          Effect.succeed(false)
      )
    )
      return false;
    let committedSideEffect = false;
    const write = writeFinalRunEvents({
      ...final,
      ...(final.hasUnpairedRunInterruptRequest === undefined
        ? {}
        : {
            hasUnpairedRunInterruptRequest: () =>
              Ref.get(supersededInterruptResultWritten).pipe(
                Effect.flatMap((written) =>
                  written ? Effect.succeed(false) : final.hasUnpairedRunInterruptRequest!(),
                ),
              ),
          }),
      refreshAfterTurn: Effect.sync(() => {
        committedSideEffect = true;
      }),
    }).pipe(
      Effect.tap((committed) =>
        !committed && committedSideEffect
          ? Ref.set(supersededInterruptResultWritten, true)
          : Effect.void,
      ),
    );
    let committed: boolean;
    while (true) {
      const decision = yield* input.session.driver !== "droid"
        ? write.pipe(Effect.map((result) => ({ type: "written", committed: result }) as const))
        : threadDispatch.withLock(
            input.run.threadId,
            Effect.gen(function* () {
              if (
                yield* (
                  input.session.droidSteerTerminalHeld?.(input.attempt.id, "completed") ??
                    Effect.succeed(false)
                )
              )
                return { type: "recheck-held" } as const;
              return { type: "written", committed: yield* write } as const;
            }),
          );
      if (decision.type === "written") {
        committed = decision.committed;
        break;
      }
      // A new hold may have committed after the outside probe. Its real
      // status-aware drop dispatch needs this same nonrecursive permit.
      if (
        yield* (
          input.session.droidSteerTerminalHeld?.(input.attempt.id, final.terminal.status) ??
            Effect.succeed(false)
        )
      )
        return false;
      // Reacquire and recheck: an outside drop is not authority to write
      // through another registration or a superseding execution owner.
    }
    if (committedSideEffect) {
      yield* final.refreshAfterTurn;
    }
    return committed;
  });
});

/** Own failed startup and interruption without closing successful detached ingestion. */
export const makeRunEventSubscriptionLifetime = Effect.fnUntraced(function* (
  closeSubscription: Effect.Effect<void>,
) {
  const close = yield* Effect.cached(closeSubscription);
  return {
    close,
    startup: <A, E, R>(prepare: () => Effect.Effect<A, E, R>) =>
      Effect.suspend(prepare).pipe(Effect.onError(() => close)),
    interrupt: <A, E>(fiber: Fiber.Fiber<A, E>) =>
      Fiber.interrupt(fiber).pipe(Effect.ensuring(close)),
  };
});

type RootReceiptOwner = Pick<
  RunExecutionServiceV2StartRootRunInput,
  "run" | "rootNode" | "providerThread" | "session" | "attemptId"
>;

const isNativeStartReceiptError = Schema.is(ProviderAdapterTurnStartError);

/** The provider turn a failed native start reported for exactly this root attempt. */
export const ownedFailedStartReceipt = (error: unknown, input: RootReceiptOwner) =>
  isNativeStartReceiptError(error) &&
  error.threadId === input.run.threadId &&
  error.runId === input.run.id &&
  error.providerThreadId === input.providerThread.id &&
  error.driver === input.session.driver &&
  error.providerTurn?.nodeId === input.rootNode.id &&
  error.providerTurn.runAttemptId === input.attemptId &&
  error.providerTurn.providerThreadId === input.providerThread.id
    ? error.providerTurn
    : undefined;

/** A stored provider-turn row that is this root attempt's own committed receipt. */
export const isCommittedRootProviderTurn = (
  storedEvent: OrchestrationV2DomainEvent,
  input: RootReceiptOwner,
  rootProviderTurnId: ProviderTurnId | null,
): storedEvent is Extract<OrchestrationV2DomainEvent, { readonly type: "provider-turn.updated" }> =>
  storedEvent.type === "provider-turn.updated" &&
  storedEvent.driver === input.session.driver &&
  storedEvent.threadId === input.run.threadId &&
  storedEvent.runId === input.run.id &&
  storedEvent.nodeId === input.rootNode.id &&
  storedEvent.providerInstanceId === input.run.providerInstanceId &&
  storedEvent.payload.id === rootProviderTurnId &&
  storedEvent.payload.nodeId === input.rootNode.id &&
  storedEvent.payload.runAttemptId === input.attemptId &&
  storedEvent.payload.providerThreadId === input.providerThread.id;
