import { createFileRoute } from "@tanstack/react-router";

import { ExternalSkillsSettings } from "../scient/skills/ExternalSkillsSettings";

function SettingsExternalSkillsRoute() {
  return <ExternalSkillsSettings />;
}

export const Route = createFileRoute("/settings/skills_/external")({
  component: SettingsExternalSkillsRoute,
});
