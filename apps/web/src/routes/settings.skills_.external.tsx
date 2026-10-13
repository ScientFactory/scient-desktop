import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { ExternalSkillsSettings } from "../scient/skills/ExternalSkillsSettings";

function SettingsExternalSkillsRoute() {
  return <ExternalSkillsSettings />;
}

export const Route = createFileRoute("/settings/skills_/external")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsExternalSkillsRoute,
});
