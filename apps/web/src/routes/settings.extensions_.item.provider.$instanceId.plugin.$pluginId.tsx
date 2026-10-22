import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
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
  "/settings/extensions_/item/provider/$instanceId/plugin/$pluginId",
)({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  /** Workspace whose provider snapshot lists a workspace-scoped plugin. */
  validateSearch: (raw: Record<string, unknown>): { workspace?: string } =>
    typeof raw.workspace === "string" && raw.workspace.trim() ? { workspace: raw.workspace } : {},
  component: SettingsExtensionsProviderPluginRoute,
});
