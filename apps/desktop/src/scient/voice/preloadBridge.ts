// @effect-diagnostics globalTimers:off -- plain Electron preload adapter.
import type { DesktopVoiceBridge, VoiceModelsSnapshot } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import * as IpcChannels from "../../ipc/channels.ts";

const MODEL_PROGRESS_POLL_MS = 500;

/** Keep all Scient voice preload behavior out of T3's inherited preload. */
export function makeDesktopVoiceBridge(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
): DesktopVoiceBridge {
  return {
    getModelsState: () => ipcRenderer.invoke(IpcChannels.VOICE_GET_MODELS_STATE_CHANNEL),
    downloadModel: (request) =>
      ipcRenderer.invoke(IpcChannels.VOICE_DOWNLOAD_MODEL_CHANNEL, request),
    cancelModelDownload: (request) =>
      ipcRenderer.invoke(IpcChannels.VOICE_CANCEL_MODEL_DOWNLOAD_CHANNEL, request),
    selectModel: (request) => ipcRenderer.invoke(IpcChannels.VOICE_SELECT_MODEL_CHANNEL, request),
    removeModel: (request) => ipcRenderer.invoke(IpcChannels.VOICE_REMOVE_MODEL_CHANNEL, request),
    transcribe: (request) => ipcRenderer.invoke(IpcChannels.VOICE_TRANSCRIBE_CHANNEL, request),
    cancelTranscription: () => ipcRenderer.invoke(IpcChannels.VOICE_CANCEL_TRANSCRIPTION_CHANNEL),
    onModelDownloadProgress: (listener) => {
      let cancelled = false;
      const poll = () => {
        void ipcRenderer
          .invoke(IpcChannels.VOICE_GET_MODELS_STATE_CHANNEL)
          .then((snapshot: VoiceModelsSnapshot) => {
            const model = snapshot.models.find(
              (candidate) => candidate.id === snapshot.activeDownloadModelId,
            );
            if (cancelled || !model || model.state.state !== "downloading") return;
            listener({
              modelId: model.id,
              downloadedBytes: model.state.downloadedBytes,
              totalBytes: model.state.totalBytes,
            });
          })
          .catch(() => {
            // A transient polling failure does not end model setup; the
            // download invocation owns the authoritative success/failure.
          });
      };
      const interval = setInterval(poll, MODEL_PROGRESS_POLL_MS);
      poll();
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    },
  };
}
