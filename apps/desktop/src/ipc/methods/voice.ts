import {
  VoiceMicrophoneAccessStatus,
  type VoiceMicrophoneAccessStatus as VoiceMicrophoneAccessStatusType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  hasLegacyVoiceModelFiles,
  removeLegacyVoiceModelFiles,
} from "../../app/LegacyVoiceModelFiles.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

interface MicrophoneSystemPreferences {
  readonly getMediaAccessStatus: (
    mediaType: "microphone",
  ) => "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  readonly askForMediaAccess: (mediaType: "microphone") => Promise<boolean>;
}

/** Keep system consent policy independently testable from Electron IPC wiring. */
export async function requestMicrophoneAccessForPlatform(
  platform: NodeJS.Platform,
  preferences: MicrophoneSystemPreferences,
): Promise<VoiceMicrophoneAccessStatusType> {
  // Windows has no consent prompt for desktop apps, only the privacy switch.
  // Anything but a clear answer falls through to renderer capture.
  if (platform === "win32") {
    try {
      const status = preferences.getMediaAccessStatus("microphone");
      return status === "granted" || status === "denied" ? status : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  if (platform !== "darwin") return "unavailable";

  try {
    const initial = preferences.getMediaAccessStatus("microphone");
    if (initial === "granted" || initial === "denied" || initial === "restricted") return initial;
    if (initial !== "not-determined") return "unavailable";

    if (await preferences.askForMediaAccess("microphone")) return "granted";
    const final = preferences.getMediaAccessStatus("microphone");
    return final === "restricted" ? "restricted" : "denied";
  } catch {
    return "unavailable";
  }
}

export const requestMicrophoneAccess = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_REQUEST_MICROPHONE_ACCESS_CHANNEL,
  payload: Schema.Void,
  result: VoiceMicrophoneAccessStatus,
  handler: Effect.fn("desktop.ipc.voice.requestMicrophoneAccess")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() =>
      requestMicrophoneAccessForPlatform(environment.platform, Electron.systemPreferences),
    );
  }),
});

class LegacyVoiceModelFilesError extends Schema.TaggedError<
  LegacyVoiceModelFilesError,
  { readonly brand: unique symbol }
>()("LegacyVoiceModelFilesError", { message: Schema.String }) {}

export const hasLegacyModels = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_HAS_LEGACY_MODELS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.voice.hasLegacyModels")(function* () {
    const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => hasLegacyVoiceModelFiles(stateDir),
      catch: () =>
        new LegacyVoiceModelFilesError({
          message: "Could not check previous dictation model files.",
        }),
    });
  }),
});

export const removeLegacyModels = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_REMOVE_LEGACY_MODELS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.voice.removeLegacyModels")(function* () {
    const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.tryPromise({
      try: () => removeLegacyVoiceModelFiles(stateDir),
      catch: () =>
        new LegacyVoiceModelFilesError({
          message: "Could not remove previous dictation model files.",
        }),
    });
  }),
});

export const hadLegacySelection = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_HAD_LEGACY_SELECTION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.voice.hadLegacySelection")(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return Boolean((yield* settings.load).voiceSelectedModelId);
  }),
});
