// FILE: desktopVoiceSetup.ts
// Purpose: Ensures the verified local fallback is installed before desktop recording starts.
// Layer: Web-to-desktop voice UX

import type { DesktopVoiceState } from "@synara/contracts";
import type { VoiceTranscriptionMode } from "../appSettings";

interface VoiceSetupFeedback {
  readonly type: "error" | "info" | "success" | "warning";
  readonly title: string;
  readonly description?: string;
}

export type ReportVoiceSetupFeedback = (feedback: VoiceSetupFeedback) => void;

export function hasDesktopVoiceRuntime(): boolean {
  return Boolean(globalThis.window?.desktopBridge?.voice);
}

export async function ensureDesktopVoiceReady(
  mode: VoiceTranscriptionMode,
  reportFeedback: ReportVoiceSetupFeedback,
): Promise<boolean> {
  const bridge = globalThis.window?.desktopBridge;
  const voice = bridge?.voice;
  if (!voice) return true;

  let state: DesktopVoiceState;
  try {
    state = await voice.getState();
  } catch {
    reportFeedback({
      type: mode === "offline-only" ? "error" : "warning",
      title: "Offline voice setup is unavailable",
      description:
        mode === "offline-only"
          ? "Restart Scient and try again."
          : "Trying ChatGPT without the offline fallback. Restart Scient to restore local voice.",
    });
    return mode !== "offline-only";
  }
  if (!state.runtimeAvailable) {
    reportFeedback({
      type: mode === "offline-only" ? "error" : "warning",
      title: "Offline voice runtime is missing",
      description: "Reinstall or update Scient, then try again.",
    });
    return mode !== "offline-only";
  }
  if (state.model.state === "ready") return true;
  if (state.model.state === "downloading") {
    reportFeedback({
      type: "info",
      title: "Offline voice model is downloading",
      description:
        mode === "offline-only"
          ? "Wait for the download to finish, then start recording."
          : "Continuing with ChatGPT while the offline fallback finishes downloading.",
    });
    return mode !== "offline-only";
  }

  const sizeMb = Math.ceil(state.modelByteSize / (1024 * 1024));
  const confirmed = await bridge.confirm(
    `Voice needs a one-time ${sizeMb} MB download for private offline transcription and reliable fallback. Download ${state.modelName} now?`,
  );
  if (!confirmed) return mode !== "offline-only";

  reportFeedback({
    type: "info",
    title: "Downloading offline voice model",
    description: `This one-time ${sizeMb} MB download is verified before it is used.`,
  });
  try {
    const installed = await voice.downloadModel();
    if (installed.model.state !== "ready") throw new Error("model not ready");
    reportFeedback({
      type: "success",
      title: "Offline voice is ready",
    });
    return true;
  } catch {
    reportFeedback({
      type: mode === "offline-only" ? "error" : "warning",
      title:
        mode === "offline-only"
          ? "Could not download the offline voice model"
          : "Offline fallback isn't ready; trying ChatGPT",
      description:
        mode === "offline-only"
          ? "Check your connection and try again from Settings."
          : "You can retry the offline model download from Settings.",
    });
    return mode !== "offline-only";
  }
}
