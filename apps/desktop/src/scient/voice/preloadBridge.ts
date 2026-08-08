// @effect-diagnostics globalTimers:off -- plain Electron preload adapter.
import type { DesktopVoiceBridge, VoiceModelState } from "@t3tools/contracts";
import type { IpcRenderer } from "electron";

import * as IpcChannels from "../../ipc/channels.ts";

const MODEL_PROGRESS_POLL_MS = 500;

/** Keep all Scient voice preload behavior out of T3's inherited preload. */
export function makeDesktopVoiceBridge(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
): DesktopVoiceBridge {
  return {
    getModelState: () => ipcRenderer.invoke(IpcChannels.VOICE_GET_MODEL_STATE_CHANNEL),
    downloadModel: () => ipcRenderer.invoke(IpcChannels.VOICE_DOWNLOAD_MODEL_CHANNEL),
    cancelModelDownload: () => ipcRenderer.invoke(IpcChannels.VOICE_CANCEL_MODEL_DOWNLOAD_CHANNEL),
    removeModel: () => ipcRenderer.invoke(IpcChannels.VOICE_REMOVE_MODEL_CHANNEL),
    transcribe: (request) => ipcRenderer.invoke(IpcChannels.VOICE_TRANSCRIBE_CHANNEL, request),
    cancelTranscription: () => ipcRenderer.invoke(IpcChannels.VOICE_CANCEL_TRANSCRIPTION_CHANNEL),
    onModelDownloadProgress: (listener) => {
      let cancelled = false;
      const poll = () => {
        void ipcRenderer
          .invoke(IpcChannels.VOICE_GET_MODEL_STATE_CHANNEL)
          .then((state: VoiceModelState) => {
            if (cancelled || state.state !== "downloading") return;
            listener({
              downloadedBytes: state.downloadedBytes,
              totalBytes: state.totalBytes,
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
