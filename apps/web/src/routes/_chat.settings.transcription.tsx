import { createFileRoute } from "@tanstack/react-router";

import { ScientVoiceSettingsPanel } from "../scient/voice/ScientVoiceSettingsPanel";

export const Route = createFileRoute("/_chat/settings/transcription")({
  component: ScientVoiceSettingsPanel,
});
