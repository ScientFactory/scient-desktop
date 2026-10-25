import { createFileRoute } from "@tanstack/react-router";

import { ScientSkillsSettings } from "../scient/skills/ScientSkillsSettings";

function SettingsSkillsRoute() {
  return <ScientSkillsSettings />;
}

export const Route = createFileRoute("/_chat/settings/skills")({
  component: SettingsSkillsRoute,
});
