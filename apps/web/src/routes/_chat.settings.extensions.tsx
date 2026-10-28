import { createFileRoute } from "@tanstack/react-router";

import { DiscoverPage } from "../scient/extensions/DiscoverPages";
import { extensionKindSearch } from "../scient/extensions/extensionsView";

function SettingsExtensionsRoute() {
  const { kind } = Route.useSearch();
  return <DiscoverPage kind={kind} />;
}

export const Route = createFileRoute("/_chat/settings/extensions")({
  validateSearch: extensionKindSearch,
  component: SettingsExtensionsRoute,
});
