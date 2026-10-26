import { createFileRoute } from "@tanstack/react-router";

import { ProviderPluginDetailPage } from "../scient/extensions/ExtensionDetailPages";

function SettingsExtensionsProviderPluginRoute() {
  const { instanceId, pluginId } = Route.useParams();
  const { workspace } = Route.useSearch();
  return (
    <ProviderPluginDetailPage instanceId={instanceId} pluginId={pluginId} workspace={workspace} />
  );
}

export const Route = createFileRoute(
  "/_chat/settings/extensions_/item/provider/$instanceId/plugin/$pluginId",
)({
  /** Workspace whose provider snapshot lists a workspace-scoped plugin. */
  validateSearch: (raw: Record<string, unknown>): { workspace?: string } =>
    typeof raw.workspace === "string" && raw.workspace.trim() ? { workspace: raw.workspace } : {},
  component: SettingsExtensionsProviderPluginRoute,
});
