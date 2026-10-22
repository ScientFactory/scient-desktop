import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { ProviderServerDetailPage } from "../scient/extensions/ExtensionDetailPages";

function SettingsExtensionsProviderServerRoute() {
  const { instanceId, serverName } = Route.useParams();
  return <ProviderServerDetailPage instanceId={instanceId} serverName={serverName} />;
}

export const Route = createFileRoute(
  "/settings/extensions_/item/provider/$instanceId/server/$serverName",
)({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsExtensionsProviderServerRoute,
});
