import { createFileRoute } from "@tanstack/react-router";

import { ProviderServerDetailPage } from "../scient/extensions/ExtensionDetailPages";

function SettingsExtensionsProviderServerRoute() {
  const { instanceId, serverName } = Route.useParams();
  return <ProviderServerDetailPage instanceId={instanceId} serverName={serverName} />;
}

export const Route = createFileRoute(
  "/_chat/settings/extensions_/item/provider/$instanceId/server/$serverName",
)({
  component: SettingsExtensionsProviderServerRoute,
});
