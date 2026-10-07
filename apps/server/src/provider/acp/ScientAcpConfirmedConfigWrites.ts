import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpRpc from "effect-acp/rpc";

import { findSessionConfigOption } from "./AcpRuntimeModel.ts";

// What a confirmed config write sees, in the order it arrived from the agent.
type ConfirmedConfigWriteEvent =
  | { readonly _tag: "ResponseArrived" }
  | {
      readonly _tag: "RequestEnded";
      readonly exit: Exit.Exit<
        EffectAcpRpc.LenientSetSessionConfigOptionResponseData,
        EffectAcpErrors.AcpError
      >;
    }
  | {
      readonly _tag: "Update";
      readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    };
interface ConfirmedConfigWrite {
  readonly events: Queue.Queue<ConfirmedConfigWriteEvent>;
  /** Set when its request is sent; its response is recognized by this id. */
  requestId: string | undefined;
}

// The client normalizes both wire generations into the compat inventory,
// preserving absent acknowledgements and authoritative [].
export const setConfigOptionInventory = (
  response: EffectAcpRpc.LenientSetSessionConfigOptionResponseData | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined => {
  if (response === undefined) return undefined;
  return response.configOptions;
};

/**
 * Confirmed config writes: each is fed its own response and the config updates
 * in the order they arrived (see `confirmConfigWrite`). They run one at a time:
 * an update names no request, so "the first update after my response" is this
 * write's report only while no other write is in flight, and the request sent
 * while a write is active is known to be its own.
 */
export const makeAcpConfirmedConfigWrites = (input: {
  readonly configOptionTransport:
    | "request"
    | "request-confirmed"
    | ((configId: string) => "request" | "request-confirmed")
    | undefined;
  readonly configOptionSettleTimeout: Duration.Input | undefined;
  readonly configOptionsRef: Ref.Ref<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
  readonly eventQueue: Queue.Enqueue<{
    readonly _tag: "ConfigOptionsUpdated";
    readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    readonly rawPayload: unknown;
  }>;
  readonly setSessionConfigOption: (
    payload: EffectAcpSchema.SetSessionConfigOptionRequest,
  ) => Effect.Effect<
    EffectAcpRpc.LenientSetSessionConfigOptionResponseData,
    EffectAcpErrors.AcpError
  >;
  readonly retireRuntime: (error: EffectAcpErrors.AcpError) => Effect.Effect<void>;
  readonly formatValue: (value: string | boolean) => string;
  readonly currentValueMatches: (
    configOption: EffectAcpSchema.SessionConfigOption,
    value: string | boolean,
  ) => boolean;
}) =>
  Effect.gen(function* () {
    const { configOptionsRef, eventQueue, retireRuntime } = input;
    const formatConfigOptionValue = input.formatValue;
    const configOptionCurrentValueMatches = input.currentValueMatches;
    const confirmsConfigWrites =
      input.configOptionTransport !== undefined && input.configOptionTransport !== "request";
    const configWriteSemaphore = yield* Semaphore.make(1);
    let activeConfigWrite: ConfirmedConfigWrite | undefined;
    /** Why the runtime was retired after a write the agent did not report. */
    let unreportedConfigWrite: EffectAcpErrors.AcpRequestError | undefined;

    // An empty acknowledgement confirms the requested value, not an empty model
    // inventory. A conforming answer carries the authoritative list; without
    // one, a notification that arrived during the request wins over the locally
    // applied value.
    const applySetConfigOptionResponse = (
      inventory: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
      previousConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      configId: string,
      value: string | boolean,
      rawPayload: unknown,
    ): Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>> =>
      Effect.gen(function* () {
        const currentConfigOptions = yield* Ref.get(configOptionsRef);
        const next =
          inventory ??
          (currentConfigOptions !== previousConfigOptions
            ? currentConfigOptions
            : currentConfigOptions.map((option): EffectAcpSchema.SessionConfigOption => {
                if (option.id !== configId) return option;
                if (option.type === "select" && typeof value === "string") {
                  return { ...option, currentValue: value };
                }
                if (option.type === "boolean" && typeof value === "boolean") {
                  return { ...option, currentValue: value };
                }
                return option;
              }));
        if (next === currentConfigOptions) return next;
        yield* Ref.set(configOptionsRef, next);
        yield* Queue.offer(eventQueue, {
          _tag: "ConfigOptionsUpdated",
          configOptions: next,
          rawPayload,
        });
        return next;
      });

    /**
     * Sends one confirmed write and settles it from what the agent reports.
     *
     * Droid answers `set_config_option` with `{}` and then publishes one
     * `config_option_update` with the state it applied, for model, reasoning
     * effort and autonomy writes alike (verified against Droid 0.183.0,
     * 0.200.0, 0.213.0 and 0.230.0). So the first update that arrives after
     * the write's response is its own: a matching value confirms, another
     * value fails at once. The order is the arrival order on the wire (the
     * response hook and the update handler both run in the reader), not the
     * order in which this fiber resumes, so an update right behind the
     * response counts.
     *
     * An update before the response is never this write's report (an earlier
     * write's, or the agent's own change): it neither confirms nor fails the
     * write. The response is recognized by the request's id, so the answer to
     * another request (a running prompt's) is not taken for it. Without a
     * response and a report after it, the write fails when the confirmation
     * timeout ends.
     *
     * The connection stays usable only when the agent settled the write: it
     * reported the applied value (the requested one or another), or refused
     * the request with a JSON-RPC error. Any other end of a write that was
     * sent (the timeout, an interruption, an answer that is not a valid one,
     * any other failure) leaves the agent's settings unknown, and its late
     * report would pass for the next write's. The runtime is retired then: the
     * process is closed and nothing more is sent to it.
     */
    const confirmConfigWrite = (
      requestPayload: EffectAcpSchema.SetSessionConfigOptionRequest,
      previousConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      configId: string,
      value: string | boolean,
    ): Effect.Effect<
      ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      EffectAcpErrors.AcpError
    > =>
      Effect.gen(function* () {
        let outcome: "unknown" | "settled" | "retired" = "unknown";
        const confirmApplied = (applied: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) => {
          outcome = "settled";
          const option = findSessionConfigOption(applied, configId);
          if (option !== undefined && configOptionCurrentValueMatches(option, value))
            return Effect.succeed(applied);
          const appliedValue = option?.currentValue ?? null;
          return Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32603,
              errorMessage: `The agent applied ${configId} ${appliedValue === null ? "no value" : formatConfigOptionValue(appliedValue)} instead of ${formatConfigOptionValue(value)}.`,
              data: { configId, requestedValue: value, appliedValue },
            }),
          );
        };
        const timeout = Duration.fromInputUnsafe(
          input.configOptionSettleTimeout ?? Duration.seconds(5),
        );
        const write: ConfirmedConfigWrite = {
          events: yield* Queue.unbounded<ConfirmedConfigWriteEvent>(),
          requestId: undefined,
        };
        activeConfigWrite = write;
        const change = `change of ${configId} to ${formatConfigOptionValue(value)}`;
        const retireUnreported = (errorMessage: string) =>
          Effect.gen(function* () {
            const error = new EffectAcpErrors.AcpRequestError({
              code: -32603,
              errorMessage,
              data: { configId, requestedValue: value },
            });
            outcome = "retired";
            unreportedConfigWrite ??= error;
            yield* retireRuntime(error);
            return yield* error;
          });
        return yield* Effect.gen(function* () {
          yield* input.setSessionConfigOption(requestPayload).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Queue.offer(write.events, { _tag: "RequestEnded", exit })),
            Effect.forkScoped,
          );
          const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout);
          let responseArrived = false;
          let response: EffectAcpRpc.LenientSetSessionConfigOptionResponseData | undefined;
          let ownUpdate: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined;
          while (true) {
            const reportedInventory = setConfigOptionInventory(response);
            if (reportedInventory) {
              // An authoritative response is the agent's report.
              return yield* confirmApplied(
                yield* applySetConfigOptionResponse(
                  reportedInventory,
                  previousConfigOptions,
                  configId,
                  value,
                  response,
                ),
              );
            }
            if (response !== undefined && ownUpdate !== undefined)
              return yield* confirmApplied(ownUpdate);
            const now = yield* Clock.currentTimeMillis;
            if (now >= deadline) {
              const waited = `within ${Duration.toMillis(timeout) / 1000} s`;
              return yield* retireUnreported(
                responseArrived
                  ? `The agent answered the ${change} but did not report the applied value ${waited}, so its session was closed.`
                  : `The agent did not answer the ${change} ${waited}, so its session was closed.`,
              );
            }
            const event = yield* Queue.take(write.events).pipe(
              Effect.timeoutOption(Duration.millis(deadline - now)),
            );
            if (Option.isNone(event)) continue;
            switch (event.value._tag) {
              case "ResponseArrived":
                responseArrived = true;
                break;
              case "RequestEnded": {
                const ended = event.value.exit;
                if (Exit.isFailure(ended)) {
                  const error = Exit.findErrorOption(ended);
                  // A JSON-RPC error response (`callRpc`) is the agent's refusal:
                  // it applied nothing and reports nothing more.
                  if (
                    Option.isSome(error) &&
                    error.value._tag === "AcpRequestError" &&
                    error.value.operation === "receive-response"
                  )
                    outcome = "settled";
                  // A success whose result does not decode is a defect, not an error.
                  else if (
                    Option.isNone(error) &&
                    write.requestId !== undefined &&
                    !Cause.hasInterrupts(ended.cause)
                  )
                    return yield* retireUnreported(
                      `The agent's answer to the ${change} was not a valid one, so its session was closed.`,
                    );
                  return yield* Effect.failCause(ended.cause);
                }
                response = ended.value;
                break;
              }
              case "Update":
                if (responseArrived) ownUpdate ??= event.value.configOptions;
                break;
            }
          }
        }).pipe(
          Effect.scoped,
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (activeConfigWrite === write) activeConfigWrite = undefined;
              if (outcome !== "unknown" || write.requestId === undefined || Exit.isSuccess(exit))
                return;
              if (Cause.hasInterrupts(exit.cause))
                return yield* retireUnreported(
                  `The ${change} was interrupted before the agent reported the applied value, so its session was closed.`,
                ).pipe(Effect.ignore);
              // The connection failed under the write: its own error says why.
              const error = Exit.findErrorOption(exit);
              if (Option.isSome(error)) return yield* retireRuntime(error.value);
              yield* retireUnreported(
                `The ${change} ended without the agent's report, so its session was closed.`,
              ).pipe(Effect.ignore);
            }),
          ),
        );
      });

    return {
      applyResponse: applySetConfigOptionResponse,
      confirm: confirmConfigWrite,
      /** Confirmed writes run one at a time. */
      serialize: <A, E, R>(write: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        confirmsConfigWrites ? configWriteSemaphore.withPermit(write) : write,
      /** Runs as a request is handed to the writer, before its bytes go out. */
      requestSent: (request: EffectAcpProtocol.AcpRequestSent): void => {
        if (
          request.method === "session/set_config_option" &&
          activeConfigWrite !== undefined &&
          activeConfigWrite.requestId === undefined
        ) {
          activeConfigWrite.requestId = String(request.requestId);
        }
      },
      // Runs in the reader, in arrival order with the session-update handler
      // and before the answer reaches the caller, so a response to another
      // request (a running prompt's) is not taken for this write's.
      onResponse: (response: EffectAcpProtocol.AcpResponseArrival) =>
        Effect.sync(() => {
          if (activeConfigWrite?.requestId === String(response.requestId)) {
            Queue.offerUnsafe(activeConfigWrite.events, { _tag: "ResponseArrived" });
          }
        }),
      // A confirmed write is fed every stored update, in the order updates arrive.
      onConfigOptionsUpdate: (configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) =>
        Effect.sync(() => {
          if (activeConfigWrite) {
            Queue.offerUnsafe(activeConfigWrite.events, { _tag: "Update", configOptions });
          }
        }),
      /** Why the runtime was retired after a write the agent did not report. */
      get unreported() {
        return unreportedConfigWrite;
      },
    };
  });

export type AcpConfirmedConfigWrites = Effect.Success<
  ReturnType<typeof makeAcpConfirmedConfigWrites>
>;
