import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { ScientSkillsSettings } from "../scient/skills/ScientSkillsSettings";

function SettingsSkillsRoute() {
  return <ScientSkillsSettings />;
}

export const Route = createFileRoute("/settings/skills")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsSkillsRoute,
});
