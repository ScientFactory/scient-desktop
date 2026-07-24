// FILE: voiceTranscription.ts
// Purpose: Registers provider-neutral desktop voice and offline-model IPC entrypoints.
// Layer: Desktop IPC

import * as Path from "node:path";

import { app, ipcMain } from "electron";

import { DesktopVoiceService } from "./voice/desktopVoiceService";
import { resolveDesktopCodexVoiceProcessContext } from "./voice/desktopCodexVoiceRuntime";
import { LocalVoiceModelManager } from "./voice/localVoiceModelManager";
import { LOCAL_VOICE_MODEL } from "./voice/localVoiceModelManifest";
import { LocalWhisperRuntime, resolveWhisperRuntimePaths } from "./voice/localWhisperRuntime";
import { DESKTOP_VOICE_IPC_CHANNELS } from "./voice/voiceIpcChannels";

let service: DesktopVoiceService | null = null;
let voiceRuntimeOptions: DesktopVoiceRuntimeOptions | null = null;

export interface DesktopVoiceRuntimeOptions {
  readonly stateDirectory: string;
  readonly scientHome: string;
}

export function registerDesktopVoiceTranscriptionHandler(
  options: DesktopVoiceRuntimeOptions,
): void {
  voiceRuntimeOptions = options;
  const voiceService = getDesktopVoiceService();
  for (const channel of Object.values(DESKTOP_VOICE_IPC_CHANNELS)) ipcMain.removeHandler(channel);
  ipcMain.handle(DESKTOP_VOICE_IPC_CHANNELS.transcribe, async (_event, input: unknown) =>
    voiceService.transcribe(input),
  );
  ipcMain.handle(DESKTOP_VOICE_IPC_CHANNELS.cancelTranscription, async () => {
    voiceService.cancelActiveTranscriptions();
  });
  ipcMain.handle(DESKTOP_VOICE_IPC_CHANNELS.getState, async () => voiceService.getState());
  ipcMain.handle(DESKTOP_VOICE_IPC_CHANNELS.downloadModel, async () =>
    voiceService.downloadModel(),
  );
  ipcMain.handle(DESKTOP_VOICE_IPC_CHANNELS.removeModel, async () => voiceService.removeModel());
  ipcMain.handle(DESKTOP_VOICE_IPC_CHANNELS.repairModel, async () => voiceService.repairModel());
}

export async function disposeDesktopVoiceTranscription(): Promise<void> {
  const active = service;
  service = null;
  if (active) await active.dispose();
}

function getDesktopVoiceService(): DesktopVoiceService {
  if (service) return service;
  if (!voiceRuntimeOptions) throw new Error("Desktop voice runtime was not configured.");
  const runtimeOptions = voiceRuntimeOptions;
  const runtimeDirectory = resolveWhisperRuntimePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopRuntimeDirectory: Path.resolve(__dirname, "..", ".electron-runtime"),
  }).runtimeDirectory;
  service = new DesktopVoiceService({
    modelManager: new LocalVoiceModelManager({
      modelsDirectory: Path.join(app.getPath("userData"), "voice", "models"),
      manifest: LOCAL_VOICE_MODEL,
    }),
    runtime: new LocalWhisperRuntime({ runtimeDirectory }),
    resolveRemoteProcessContext: () => resolveDesktopCodexVoiceProcessContext(runtimeOptions),
  });
  return service;
}
