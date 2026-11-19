import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  LiveVoiceCallEvent,
  LiveVoiceCallInput,
  LiveVoiceError,
  LiveVoiceMuteInput,
} from "./liveVoice.ts";

/** Spread into rpc.ts WS_METHODS. */
export const SCIENT_LIVE_VOICE_WS_METHODS = {
  liveVoiceCall: "liveVoice.call",
  liveVoiceMute: "liveVoice.mute",
} as const;

/** Starts a call and streams its events; ending the subscription hangs up. */
export const WsLiveVoiceCallRpc = Rpc.make(SCIENT_LIVE_VOICE_WS_METHODS.liveVoiceCall, {
  payload: LiveVoiceCallInput,
  success: LiveVoiceCallEvent,
  stream: true,
  error: Schema.Union([LiveVoiceError, EnvironmentAuthorizationError]),
});

export const WsLiveVoiceMuteRpc = Rpc.make(SCIENT_LIVE_VOICE_WS_METHODS.liveVoiceMute, {
  payload: LiveVoiceMuteInput,
  success: Schema.Struct({ muted: Schema.Boolean }),
  error: Schema.Union([LiveVoiceError, EnvironmentAuthorizationError]),
});
