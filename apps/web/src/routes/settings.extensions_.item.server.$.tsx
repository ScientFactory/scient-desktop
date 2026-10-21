import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { ServerDetailPage } from "../scient/extensions/ExtensionDetailPages";

/** Registry names carry their own slash (`io.github.owner/server`), so the name is the rest of the path. */
function SettingsExtensionsServerRoute() {
  const { _splat } = Route.useParams();
  return <ServerDetailPage name={_splat ?? ""} />;
}

export const Route = createFileRoute("/settings/extensions_/item/server/$")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsExtensionsServerRoute,
});
