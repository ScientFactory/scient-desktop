import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { OpenSourceLicensesPanel } from "../components/settings/OpenSourceLicenses";

export const Route = createFileRoute("/settings/open-source-licenses")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: OpenSourceLicensesPanel,
});
