import {
  VoiceCapabilitySnapshot,
  VoiceModelState,
  VoiceTranscribeRequest,
  VoiceTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopVoice from "../../app/DesktopVoice.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getVoiceCapability = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_GET_CAPABILITY_CHANNEL,
  payload: Schema.Void,
  result: VoiceCapabilitySnapshot,
  handler: Effect.fn("desktop.ipc.voice.getCapability")(function* () {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.getCapability;
  }),
});

export const getVoiceModelState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_GET_MODEL_STATE_CHANNEL,
  payload: Schema.Void,
  result: VoiceModelState,
  handler: Effect.fn("desktop.ipc.voice.getModelState")(function* () {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.getModelState;
  }),
});

export const downloadVoiceModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_DOWNLOAD_MODEL_CHANNEL,
  payload: Schema.Void,
  result: VoiceModelState,
  handler: Effect.fn("desktop.ipc.voice.downloadModel")(function* () {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.downloadModel;
  }),
});

export const removeVoiceModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_REMOVE_MODEL_CHANNEL,
  payload: Schema.Void,
  result: VoiceModelState,
  handler: Effect.fn("desktop.ipc.voice.removeModel")(function* () {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.removeModel;
  }),
});

export const transcribeVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_TRANSCRIBE_CHANNEL,
  payload: VoiceTranscribeRequest,
  result: VoiceTranscript,
  handler: Effect.fn("desktop.ipc.voice.transcribe")(function* (request) {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.transcribe(request);
  }),
});

export const cancelVoiceTranscription = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_CANCEL_TRANSCRIPTION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voice.cancelTranscription")(function* () {
    const voice = yield* DesktopVoice.DesktopVoice;
    yield* voice.cancelTranscription;
  }),
});
