import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { runStream } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type LiveVoiceCallEvent,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../../connection/runtime.ts";

const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    signal.addEventListener("abort", () => resume(Effect.void), { once: true });
  });

/** Runs a call until it ends or `signal` aborts; aborting ends the stream, which hangs up. */
export const liveVoiceCallCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:live-voice:call",
  execute: Effect.fn("liveVoiceCall")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly sdpOffer: string;
    readonly signal: AbortSignal;
    readonly onEvent: (event: LiveVoiceCallEvent) => void;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry
      .runStream(
        input.environmentId,
        runStream(WS_METHODS.liveVoiceCall, {
          threadId: input.threadId,
          sdpOffer: input.sdpOffer,
        }),
      )
      .pipe(
        Stream.runForEach((event) => Effect.sync(() => input.onEvent(event))),
        Effect.raceFirst(aborted(input.signal)),
      );
  }),
});

export const liveVoiceMuteCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "web:live-voice:mute",
  tag: WS_METHODS.liveVoiceMute,
  concurrency: { mode: "serial", key: (input) => input.input.threadId },
});
