// Scient live voice: the provider-side contract for a spoken conversation with a running
// session. Re-exported from ProviderAdapter.ts; only Scient Agent implements it.
import type { LiveVoiceCallEvent } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class ScientLiveVoiceFailure extends Schema.TaggedError<ScientLiveVoiceFailure>()(
  "ScientLiveVoiceFailure",
  {
    reason: Schema.Literals(["call-active", "call-failed"]),
    detail: Schema.optional(Schema.String),
  },
) {}

export interface ScientLiveVoiceRuntime {
  /**
   * Starts a call on the caller's WebRTC offer. The first event carries the answer and the
   * last one says the call ended; ending the stream early hangs up.
   */
  readonly call: (sdpOffer: string) => Stream.Stream<LiveVoiceCallEvent, ScientLiveVoiceFailure>;
  readonly mute: (muted: boolean) => Effect.Effect<boolean, ScientLiveVoiceFailure>;
}
