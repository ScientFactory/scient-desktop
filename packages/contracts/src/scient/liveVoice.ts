import * as Schema from "effect/Schema";

import { ThreadId } from "../baseSchemas.ts";

/**
 * A spoken conversation with a thread's Scient Agent. The window owns the microphone and
 * speaker through WebRTC; the server only passes the call setup to the agent and its
 * status back. Closing the call stream hangs up.
 */
export const LiveVoiceCallInput = Schema.Struct({
  threadId: ThreadId,
  /** The window's WebRTC offer: one audio track and an `oai-events` data channel. */
  sdpOffer: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
export type LiveVoiceCallInput = typeof LiveVoiceCallInput.Type;

export const LiveVoicePhase = Schema.Literals([
  "connecting",
  "listening",
  "working",
  "speaking",
  "muted",
  "error",
]);
export type LiveVoicePhase = typeof LiveVoicePhase.Type;

export const LiveVoiceCallEvent = Schema.Union([
  /** First event: the answer for the window's peer. */
  Schema.Struct({
    type: Schema.Literal("answer"),
    sdpAnswer: Schema.String,
    voice: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("phase"), phase: LiveVoicePhase }),
  /** Partial or final text of one spoken turn; a later event for the same role and turn replaces it. */
  Schema.Struct({
    type: Schema.Literal("transcript"),
    role: Schema.Literals(["user", "assistant"]),
    turn: Schema.Number,
    text: Schema.String,
    final: Schema.Boolean,
  }),
  /** A spoken request the agent should work on; the server sends it as the user's message. */
  Schema.Struct({ type: Schema.Literal("request"), text: Schema.String }),
  /** Last event; `error` says why the call ended when it failed. */
  Schema.Struct({ type: Schema.Literal("ended"), error: Schema.optional(Schema.String) }),
]);
export type LiveVoiceCallEvent = typeof LiveVoiceCallEvent.Type;

export const LiveVoiceMuteInput = Schema.Struct({ threadId: ThreadId, muted: Schema.Boolean });
export type LiveVoiceMuteInput = typeof LiveVoiceMuteInput.Type;

export const LiveVoiceErrorReason = Schema.Literals([
  "provider-unsupported",
  "session-stopped",
  "call-active",
  "call-failed",
]);
export type LiveVoiceErrorReason = typeof LiveVoiceErrorReason.Type;

export class LiveVoiceError extends Schema.TaggedError<LiveVoiceError>()("LiveVoiceError", {
  threadId: ThreadId,
  reason: LiveVoiceErrorReason,
  /** The agent's own words when it refused or the call failed. */
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "provider-unsupported":
        return "Voice calls work with Scient Agent threads.";
      case "session-stopped":
        return "Scient Agent isn't running in this thread. Send a message, then start the call.";
      case "call-active":
        return "A voice call is already running in this thread.";
      case "call-failed":
        return this.detail ?? "The voice call couldn't start.";
    }
  }
}
