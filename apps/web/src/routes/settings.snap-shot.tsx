import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { SnapShotSettings } from "../components/settings/SnapShotSettings";

function SettingsSnapShotRoute() {
  return <SnapShotSettings />;
}

export const Route = createFileRoute("/settings/snap-shot")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsSnapShotRoute,
});
