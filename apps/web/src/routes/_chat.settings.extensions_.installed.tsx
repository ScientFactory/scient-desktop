import { createFileRoute } from "@tanstack/react-router";

import { InstalledPage } from "../scient/extensions/InstalledPage";
import { extensionKindSearch } from "../scient/extensions/extensionsView";

function SettingsExtensionsInstalledRoute() {
  const { kind } = Route.useSearch();
  return <InstalledPage kind={kind} />;
}

export const Route = createFileRoute("/_chat/settings/extensions_/installed")({
  validateSearch: extensionKindSearch,
  component: SettingsExtensionsInstalledRoute,
});
