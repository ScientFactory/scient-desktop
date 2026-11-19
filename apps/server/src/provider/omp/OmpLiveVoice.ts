/**
 * Scient Agent live voice: the window's WebRTC peer carries the audio and the agent signals the
 * call. With `hostDelegation`, each spoken request comes back as a `live_delegation` frame for
 * Desktop to send as the user's message; an older agent starts those turns itself.
 */
import type { LiveVoiceCallEvent, LiveVoicePhase } from "@t3tools/contracts";
import type { OmpRpcClient } from "effect-omp-rpc/client";
import {
  ScientLiveVoiceFailure,
  type ScientLiveVoiceRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { isRecord } from "effect-omp-rpc/schema";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const PHASES: ReadonlySet<string> = new Set<LiveVoicePhase>([
  "connecting",
  "listening",
  "working",
  "speaking",
  "muted",
  "error",
]);

/** Whether an agent event belongs to live voice, so the turn machine never sees it. */
export const isOmpLiveFrame = (type: string): boolean => type.startsWith("live_");

/** A live frame as a call event; levels and unreadable frames give none. */
const decodeOmpLiveFrame = (frame: unknown): LiveVoiceCallEvent | undefined => {
  if (!isRecord(frame)) return undefined;
  switch (frame.type) {
    case "live_phase":
      return typeof frame.phase === "string" && PHASES.has(frame.phase)
        ? { type: "phase", phase: frame.phase as LiveVoicePhase }
        : undefined;
    case "live_transcript":
      return (frame.role === "user" || frame.role === "assistant") &&
        typeof frame.turn === "number" &&
        typeof frame.text === "string"
        ? {
            type: "transcript",
            role: frame.role,
            turn: frame.turn,
            text: frame.text,
            final: frame.final === true,
          }
        : undefined;
    case "live_delegation":
      return typeof frame.text === "string" && frame.text.trim()
        ? { type: "request", text: frame.text.trim() }
        : undefined;
    case "live_end":
      return typeof frame.error === "string" && frame.error.trim()
        ? { type: "ended", error: frame.error }
        : { type: "ended" };
    default:
      return undefined;
  }
};

export interface OmpLiveVoice {
  readonly runtime: ScientLiveVoiceRuntime;
  /** Every `live_*` frame the agent sends. */
  readonly onFrame: (frame: unknown) => Effect.Effect<void>;
  /** The agent process is gone; a call in progress ends. */
  readonly onProcessEnded: Effect.Effect<void>;
}

const failed = (detail: string) => new ScientLiveVoiceFailure({ reason: "call-failed", detail });

export const makeOmpLiveVoice = (client: OmpRpcClient): OmpLiveVoice => {
  /** The call in progress; frames go to its queue. One call per session, as in the agent. */
  let active: Queue.Queue<LiveVoiceCallEvent> | undefined;

  const end = (event: Extract<LiveVoiceCallEvent, { type: "ended" }>) =>
    Effect.suspend(() => {
      const queue = active;
      if (queue === undefined) return Effect.void;
      active = undefined;
      // The call stream stops at this event.
      return Queue.offer(queue, event).pipe(Effect.asVoid);
    });

  const call = (sdpOffer: string): Stream.Stream<LiveVoiceCallEvent, ScientLiveVoiceFailure> =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (active !== undefined) {
          return yield* new ScientLiveVoiceFailure({ reason: "call-active" });
        }
        const queue = yield* Queue.unbounded<LiveVoiceCallEvent>();
        // Frames can arrive before the answer; they wait in the queue behind it.
        active = queue;
        const hangUp = Effect.suspend(() => {
          if (active !== queue) return Effect.void;
          active = undefined;
          return client.command({ type: "live_stop" }).pipe(Effect.ignore);
        });
        const response = yield* client
          .command({ type: "live_connect", sdpOffer, hostDelegation: true })
          .pipe(
            Effect.mapError((cause) => failed(cause.message)),
            // A window that hangs up while the agent is still connecting must not leave the
            // call running; `live_stop` without a call is harmless.
            Effect.onError(() => hangUp),
          );
        const data = isRecord(response.data) ? response.data : {};
        if (typeof data.sdpAnswer !== "string" || !data.sdpAnswer) {
          yield* hangUp;
          return yield* failed("Scient Agent did not answer the call.");
        }
        const answer: LiveVoiceCallEvent = {
          type: "answer",
          sdpAnswer: data.sdpAnswer,
          voice: typeof data.voice === "string" ? data.voice : "",
        };
        return Stream.make(answer).pipe(
          Stream.concat(Stream.fromQueue(queue)),
          Stream.takeUntil((event) => event.type === "ended"),
          Stream.ensuring(hangUp),
        );
      }),
    );

  const mute = Effect.fn("OmpLiveVoice.mute")(function* (muted: boolean) {
    if (active === undefined) return yield* failed("No voice call is running.");
    const response = yield* client
      .command({ type: "live_mute", muted })
      .pipe(Effect.mapError((cause) => failed(cause.message)));
    return isRecord(response.data) && typeof response.data.muted === "boolean"
      ? response.data.muted
      : muted;
  });

  return {
    runtime: { call, mute },
    onFrame: (frame) =>
      Effect.suspend(() => {
        const event = decodeOmpLiveFrame(frame);
        if (event === undefined || active === undefined) return Effect.void;
        if (event.type === "ended") return end(event);
        return Queue.offer(active, event).pipe(Effect.asVoid);
      }),
    onProcessEnded: end({ type: "ended", error: "Scient Agent stopped." }),
  };
};
