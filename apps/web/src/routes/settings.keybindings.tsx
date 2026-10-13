import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";

export const Route = createFileRoute("/settings/keybindings")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: KeybindingsSettingsPanel,
});
