import { createFileRoute } from "@tanstack/react-router";

import { ServerDetailPage } from "../scient/extensions/ExtensionDetailPages";

/** Registry names carry their own slash (`io.github.owner/server`), so the name is the rest of the path. */
function SettingsExtensionsServerRoute() {
  const { _splat } = Route.useParams();
  return <ServerDetailPage name={_splat ?? ""} />;
}

export const Route = createFileRoute("/_chat/settings/extensions_/item/server/$")({
  component: SettingsExtensionsServerRoute,
});
