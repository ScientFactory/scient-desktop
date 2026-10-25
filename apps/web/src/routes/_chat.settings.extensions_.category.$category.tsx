import { createFileRoute } from "@tanstack/react-router";

import { CategoryPage } from "../scient/extensions/DiscoverPages";

function SettingsExtensionsCategoryRoute() {
  const { category } = Route.useParams();
  return <CategoryPage category={category} />;
}

export const Route = createFileRoute("/_chat/settings/extensions_/category/$category")({
  component: SettingsExtensionsCategoryRoute,
});
