import { createFileRoute } from "@tanstack/react-router";

import { ProjectSkillsSettingsPage } from "../scient/skills/ProjectSkillsSettingsPage";

function SettingsProjectSkillsRoute() {
  return <ProjectSkillsSettingsPage />;
}

export const Route = createFileRoute("/settings/skills_/project")({
  component: SettingsProjectSkillsRoute,
});
