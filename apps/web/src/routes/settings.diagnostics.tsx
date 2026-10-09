import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { DiagnosticsSettingsPanel } from "../components/settings/DiagnosticsSettings";

export const Route = createFileRoute("/settings/diagnostics")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: DiagnosticsSettingsPanel,
});
