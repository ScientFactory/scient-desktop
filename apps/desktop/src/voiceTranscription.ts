// FILE: voiceTranscription.ts
// Purpose: Registers the desktop IPC compatibility entrypoint for voice transcription.
// Layer: Desktop IPC
// Depends on: The isolated ChatGPT voice adapter until the shared router owns selection.

import { ipcMain } from "electron";
import type { ServerVoiceTranscriptionInput } from "@synara/contracts";

import { transcribeVoiceViaDesktopBridge } from "./voice/chatGptVoiceTranscription";

export const SERVER_TRANSCRIBE_VOICE_CHANNEL = "desktop:server-transcribe-voice";

export function registerDesktopVoiceTranscriptionHandler(): void {
  ipcMain.removeHandler(SERVER_TRANSCRIBE_VOICE_CHANNEL);
  ipcMain.handle(
    SERVER_TRANSCRIBE_VOICE_CHANNEL,
    async (_event, input: ServerVoiceTranscriptionInput) => transcribeVoiceViaDesktopBridge(input),
  );
}
