import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { ProjectSkillsSettingsPage } from "../scient/skills/ProjectSkillsSettingsPage";

function SettingsProjectSkillsRoute() {
  return <ProjectSkillsSettingsPage />;
}

export const Route = createFileRoute("/settings/skills_/project")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsProjectSkillsRoute,
});
