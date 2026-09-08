import {
  VoiceModelDownloadRequest,
  VoiceModelOperationRequest,
  VoiceModelRemoveRequest,
  VoiceModelsSnapshot,
  VoiceTranscribeRequest,
  VoiceTranscript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopVoice from "../../app/DesktopVoice.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const getVoiceModelsState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_GET_MODELS_STATE_CHANNEL,
  payload: Schema.Void,
  result: VoiceModelsSnapshot,
  handler: Effect.fn("desktop.ipc.voice.getModelsState")(function* () {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.getModelsState;
  }),
});

const downloadVoiceModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_DOWNLOAD_MODEL_CHANNEL,
  payload: VoiceModelDownloadRequest,
  result: VoiceModelsSnapshot,
  handler: Effect.fn("desktop.ipc.voice.downloadModel")(function* (request) {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.downloadModel(request);
  }),
});

const cancelVoiceModelDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_CANCEL_MODEL_DOWNLOAD_CHANNEL,
  payload: VoiceModelOperationRequest,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voice.cancelModelDownload")(function* (request) {
    const voice = yield* DesktopVoice.DesktopVoice;
    yield* voice.cancelModelDownload(request);
  }),
});

const selectVoiceModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_SELECT_MODEL_CHANNEL,
  payload: VoiceModelOperationRequest,
  result: VoiceModelsSnapshot,
  handler: Effect.fn("desktop.ipc.voice.selectModel")(function* (request) {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.selectModel(request);
  }),
});

const removeVoiceModel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_REMOVE_MODEL_CHANNEL,
  payload: VoiceModelRemoveRequest,
  result: VoiceModelsSnapshot,
  handler: Effect.fn("desktop.ipc.voice.removeModel")(function* (request) {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.removeModel(request);
  }),
});

const transcribeVoice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_TRANSCRIBE_CHANNEL,
  payload: VoiceTranscribeRequest,
  result: VoiceTranscript,
  handler: Effect.fn("desktop.ipc.voice.transcribe")(function* (request) {
    const voice = yield* DesktopVoice.DesktopVoice;
    return yield* voice.transcribe(request);
  }),
});

const cancelVoiceTranscription = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_CANCEL_TRANSCRIPTION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voice.cancelTranscription")(function* () {
    const voice = yield* DesktopVoice.DesktopVoice;
    yield* voice.cancelTranscription;
  }),
});

export const methods = [
  getVoiceModelsState,
  downloadVoiceModel,
  cancelVoiceModelDownload,
  selectVoiceModel,
  removeVoiceModel,
  transcribeVoice,
  cancelVoiceTranscription,
] as const;
