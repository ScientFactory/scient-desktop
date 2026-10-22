import {
  SettingsRoutePending,
  SettingsRouteError,
} from "../components/settings/SettingsRouteLoading";
import { createFileRoute } from "@tanstack/react-router";

import { CategoryPage } from "../scient/extensions/DiscoverPages";

function SettingsExtensionsCategoryRoute() {
  const { category } = Route.useParams();
  return <CategoryPage category={category} />;
}

export const Route = createFileRoute("/settings/extensions_/category/$category")({
  pendingComponent: SettingsRoutePending,
  pendingMs: 80,
  pendingMinMs: 0,
  errorComponent: SettingsRouteError,
  component: SettingsExtensionsCategoryRoute,
});
