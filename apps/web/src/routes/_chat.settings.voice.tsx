import { createFileRoute } from "@tanstack/react-router";

import { VoiceSettingsPanel } from "../components/settings/VoiceSettingsPanel";
// SCIENT-FORK:START — Scient's voice page stays until the voice decision; T3's page is dormant.
import { ScientVoiceSettingsPanel } from "../scient/voice/ScientVoiceSettingsPanel";

const SCIENT_SHOWS_T3_VOICE_PAGE: boolean = false;
// SCIENT-FORK:END

export const Route = createFileRoute("/_chat/settings/voice")({
  // SCIENT-FORK: Scient's voice page in place of T3's.
  component: SCIENT_SHOWS_T3_VOICE_PAGE ? VoiceSettingsPanel : ScientVoiceSettingsPanel,
});
