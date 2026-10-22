import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { ConnectorDetailPage } from "../scient/extensions/ExtensionDetailPages";

function SettingsExtensionsConnectorRoute() {
  const { connectorId } = Route.useParams();
  return <ConnectorDetailPage connectorId={connectorId} />;
}

export const Route = createFileRoute("/settings/extensions_/item/connector/$connectorId")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsExtensionsConnectorRoute,
});
