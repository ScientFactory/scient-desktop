import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { PluginDetailPage } from "../scient/extensions/ExtensionDetailPages";

function SettingsExtensionsPluginRoute() {
  const { pluginId } = Route.useParams();
  return <PluginDetailPage pluginId={pluginId} />;
}

export const Route = createFileRoute("/settings/extensions_/item/plugin/$pluginId")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsExtensionsPluginRoute,
});
