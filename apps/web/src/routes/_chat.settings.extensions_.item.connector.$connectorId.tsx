import { createFileRoute } from "@tanstack/react-router";

import { ConnectorDetailPage } from "../scient/extensions/ExtensionDetailPages";

function SettingsExtensionsConnectorRoute() {
  const { connectorId } = Route.useParams();
  return <ConnectorDetailPage connectorId={connectorId} />;
}

export const Route = createFileRoute("/_chat/settings/extensions_/item/connector/$connectorId")({
  component: SettingsExtensionsConnectorRoute,
});
