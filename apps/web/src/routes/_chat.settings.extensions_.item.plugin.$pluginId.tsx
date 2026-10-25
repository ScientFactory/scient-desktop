import { createFileRoute } from "@tanstack/react-router";

import { PluginDetailPage } from "../scient/extensions/ExtensionDetailPages";

function SettingsExtensionsPluginRoute() {
  const { pluginId } = Route.useParams();
  return <PluginDetailPage pluginId={pluginId} />;
}

export const Route = createFileRoute("/_chat/settings/extensions_/item/plugin/$pluginId")({
  component: SettingsExtensionsPluginRoute,
});
