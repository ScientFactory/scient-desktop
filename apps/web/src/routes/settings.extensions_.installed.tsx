import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { InstalledPage } from "../scient/extensions/InstalledPage";

export const Route = createFileRoute("/settings/extensions_/installed")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: InstalledPage,
});
