// SCIENT-FORK:START — native Droid readiness is a lease, never a persisted execution authority.
import type { ProviderTurnId, RunAttemptId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/compat";
import {
  mergeToolCallState,
  parseSessionUpdateEvent,
} from "@t3tools/provider-acp/server/runtimeModel";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import {
  makeDroidSubagentTracker,
  observeDroidSubagentToolCall,
  droidSubagentActivity,
} from "../../provider/droid/DroidSubagents.ts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";

export class DroidSteerDeferred extends Data.TaggedError("DroidSteerDeferred") {}
export class DroidSteerUncertain extends Data.TaggedError("DroidSteerUncertain")<{
  readonly message: string;
}> {}

export function makeDroidSteerSafety() {
  const tasks = makeDroidSubagentTracker();
  const tools = new Map<string, AcpToolCallState>();
  let epoch = 0;
  let depth = 0;
  let failed = false;
  let consumed = false;
  let returned = false;
  let lease: { id: string; epoch: number } | undefined;
  let serial = 0;
  const invalidate = () => {
    epoch++;
    lease = undefined;
  };
  const ready = () =>
    !failed &&
    !consumed &&
    depth === 0 &&
    (returned
      ? droidSubagentActivity(tasks).background === 0
      : !Array.from(tools.values()).some(
          (tool) =>
            tool.status === "pending" ||
            tool.status === "inProgress" ||
            tool.status === "requiresAction",
        ) && droidSubagentActivity(tasks).open === 0);
  const validate = (id: string) => ready() && lease?.id === id && lease.epoch === epoch;
  return {
    invalidate,
    promptReturned() {
      invalidate();
      returned = true;
    },
    toolIds: (): ReadonlyArray<string> => Array.from(tools.keys()),
    batch(phase: "begin" | "end" | "failed") {
      invalidate();
      if (phase === "begin") depth++;
      else {
        depth = Math.max(0, depth - 1);
        if (phase === "failed") failed = true;
      }
    },
    observe(tool: AcpToolCallState, turnId: string) {
      invalidate();
      const merged = mergeToolCallState(tools.get(tool.toolCallId), tool);
      tools.set(tool.toolCallId, merged);
      observeDroidSubagentToolCall(tasks, merged, turnId);
    },
    reserve(revision: string) {
      if (!ready()) return undefined;
      const id = `${revision}:${++serial}`;
      lease = { id, epoch };
      return id;
    },
    validate,
    consume(id: string) {
      if (!validate(id)) return false;
      consumed = true;
      lease = undefined;
      return true;
    },
    get consumed() {
      return consumed;
    },
  };
}

type DroidSteerOwnerTurn = {
  readonly droidSteerSafety?: ReturnType<typeof makeDroidSteerSafety>;
  readonly providerTurnId: ProviderTurnId;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly input: { readonly attemptId: RunAttemptId };
  readonly interrupted: boolean;
  readonly finalized: boolean;
  readonly promptWireSettled: Deferred.Deferred<void, never>;
  readonly tools: ReadonlyMap<string, unknown>;
};

type DroidSteerRuntimeMethods = Pick<
  ProviderAdapterV2SessionRuntime,
  | "configureDroidSteerOwner"
  | "droidSteerTerminalHeld"
  | "invalidateDroidSteer"
  | "validateDroidSteer"
  | "droidSteerConsumed"
  | "reserveDroidSteer"
  | "consumeDroidSteer"
>;

/**
 * Scoped observations and leases of one ACP session's Droid owner; no durable
 * readiness or replay authority. Opt-in flavors only (`enabled`).
 */
export function makeAcpDroidSteerSupervision<Turn extends DroidSteerOwnerTurn>(input: {
  readonly enabled: boolean;
  readonly testHooks:
    | {
        readonly afterDroidDecodedBatchBegin?: () => Effect.Effect<void>;
        readonly afterDroidSteerReserved?: (lease: string) => Effect.Effect<void>;
        readonly beforeDroidSteerConsume?: () => Effect.Effect<void>;
      }
    | undefined;
}) {
  const { enabled } = input;
  let droidOwner: Turn | undefined;
  const retiredDroidToolIds = new Set<string>();
  let droidBatchDepth = 0;
  let droidNativeGeneration: number | undefined;
  let droidClosed = false;
  let droidPendingRequestCount = 0;
  let droidBatchEpoch = 0;
  let droidLease: { id: string; epoch: number; context: Turn } | undefined;
  let consumedDroidLease: string | undefined;
  let droidCanonicalOwner:
    | Parameters<NonNullable<ProviderAdapterV2SessionRuntime["configureDroidSteerOwner"]>>[0]
    | undefined;
  const invalidateDroidSteer = () => {
    droidLease = undefined;
    droidOwner?.droidSteerSafety?.invalidate();
  };
  const validDroidLease = (id: string) =>
    !droidClosed &&
    droidBatchDepth === 0 &&
    droidPendingRequestCount === 0 &&
    droidLease?.id === id &&
    droidLease.epoch === droidBatchEpoch &&
    droidLease.context === droidOwner &&
    droidOwner?.droidSteerSafety?.validate(id) === true;
  const consumeDroidLease = (id: string) => {
    if (!validDroidLease(id)) return false;
    const consumed = droidOwner!.droidSteerSafety!.consume(id);
    if (consumed) consumedDroidLease = id;
    droidLease = undefined;
    return consumed;
  };
  return {
    enabled,
    invalidate: invalidateDroidSteer,
    consume: consumeDroidLease,
    /** Pending native requests block readiness; every change invalidates the lease. */
    setPendingRequestCount(count: number) {
      droidPendingRequestCount = count;
      invalidateDroidSteer();
    },
    close() {
      droidClosed = true;
      invalidateDroidSteer();
    },
    /** The native process of this generation terminated. */
    terminated(runtimeGeneration: number) {
      if (enabled && droidNativeGeneration === runtimeGeneration) {
        droidClosed = true;
        invalidateDroidSteer();
      }
    },
    /** A new native process generation starts with no owner, lease or retired tools. */
    beginGeneration(runtimeGeneration: number) {
      if (enabled && droidNativeGeneration !== runtimeGeneration) {
        invalidateDroidSteer();
        droidOwner = undefined;
        consumedDroidLease = undefined;
        retiredDroidToolIds.clear();
        droidNativeGeneration = runtimeGeneration;
        droidClosed = false;
      }
    },
    // All notification handlers are awaited by the protocol route. No permit or reader wait here.
    onDecodedBatch: (phase: "begin" | "end" | "failed") =>
      Effect.sync(() => {
        droidBatchEpoch++;
        invalidateDroidSteer();
        if (phase === "begin") droidBatchDepth++;
        else droidBatchDepth = Math.max(0, droidBatchDepth - 1);
        if (phase === "failed") droidOwner?.droidSteerSafety?.batch("failed");
      }).pipe(
        Effect.andThen(
          phase === "begin" && droidOwner !== undefined
            ? (input.testHooks?.afterDroidDecodedBatchBegin?.() ?? Effect.void)
            : Effect.void,
        ),
      ),
    /** An old tool's update cannot become an open step of its replacement prompt. */
    isRetiredToolUpdate: (
      update: EffectAcpSchema.SessionNotification["update"],
      context: Turn | null,
    ) =>
      enabled &&
      update.sessionUpdate === "tool_call_update" &&
      retiredDroidToolIds.has(update.toolCallId) &&
      !context?.tools.has(update.toolCallId),
    /** Observe before presentation cleanup, also after the successful root prompt returned. */
    observe(notification: EffectAcpSchema.SessionNotification) {
      if (droidOwner?.nativeThreadId === notification.sessionId) {
        for (const event of parseSessionUpdateEvent(notification).events) {
          if (event._tag === "ToolCallUpdated")
            droidOwner.droidSteerSafety?.observe(event.toolCall, droidOwner.nativeTurnId);
        }
      }
    },
    /** A new root prompt owns readiness; its predecessor's tools are retired. */
    adopt(context: Turn) {
      if (enabled) {
        for (const id of droidOwner?.droidSteerSafety?.toolIds() ?? []) retiredDroidToolIds.add(id);
        while (retiredDroidToolIds.size > 2_000)
          retiredDroidToolIds.delete(retiredDroidToolIds.values().next().value!);
        invalidateDroidSteer();
        consumedDroidLease = undefined;
        droidOwner = context;
      }
    },
    /** Canonical callbacks are bound by registration, never inferred from logs. */
    runtimeMethods: (
      interruptTurn: ProviderAdapterV2SessionRuntime["interruptTurn"],
    ): DroidSteerRuntimeMethods =>
      !enabled
        ? {}
        : {
            configureDroidSteerOwner: (owner) =>
              Effect.sync(() => {
                droidCanonicalOwner = owner;
              }),
            droidSteerTerminalHeld: (attemptId, status) =>
              Effect.gen(function* () {
                const owner = droidCanonicalOwner;
                if (owner?.attemptId !== attemptId || !(yield* owner.held)) return false;
                if (
                  status === "failed" ||
                  (status !== "completed" && droidOwner?.droidSteerSafety?.consumed !== true)
                ) {
                  yield* owner.drop;
                  return false;
                }
                return true;
              }),
            invalidateDroidSteer,
            validateDroidSteer: validDroidLease,
            droidSteerConsumed: (lease) =>
              !droidClosed &&
              consumedDroidLease !== undefined &&
              (lease === undefined || consumedDroidLease === lease),
            reserveDroidSteer: (identity) =>
              Effect.sync(() => {
                if (
                  droidClosed ||
                  droidBatchDepth !== 0 ||
                  droidPendingRequestCount !== 0 ||
                  droidOwner?.providerTurnId !== identity.providerTurnId ||
                  droidOwner.input.attemptId !== identity.attemptId ||
                  droidOwner.interrupted
                )
                  return undefined;
                const id = droidOwner.droidSteerSafety?.reserve(identity.revision);
                if (id !== undefined)
                  droidLease = { id, epoch: droidBatchEpoch, context: droidOwner };
                return id;
              }).pipe(
                Effect.tap((id) =>
                  id === undefined
                    ? Effect.void
                    : (input.testHooks?.afterDroidSteerReserved?.(id) ?? Effect.void),
                ),
              ),
            consumeDroidSteer: (turnInput) =>
              Effect.gen(function* () {
                const owner = droidOwner;
                if (owner?.providerTurnId !== turnInput.providerTurnId) return false;
                if (owner.finalized) {
                  // Successful prompt completion already closed this exact owner: no cancel is needed.
                  if (!(yield* Deferred.isDone(owner.promptWireSettled))) return false;
                  yield* input.testHooks?.beforeDroidSteerConsume?.() ?? Effect.void;
                  return consumeDroidLease(turnInput.droidSteerLease);
                }
                return yield* interruptTurn(turnInput).pipe(
                  Effect.map(
                    () => !droidClosed && consumedDroidLease === turnInput.droidSteerLease,
                  ),
                  Effect.catchTags({
                    ProviderAdapterInterruptError: (error) =>
                      error.cause instanceof DroidSteerDeferred
                        ? Effect.succeed(false)
                        : Effect.fail(error),
                  }),
                );
              }),
          },
  };
}
// SCIENT-FORK:END
