import { createFileRoute } from "@tanstack/react-router";
import { ProviderStoreDetailPage } from "../scient/extensions/ProviderStorePages";
export const Route = createFileRoute("/_chat/settings/extensions_/item/store/$instanceId/$entryId")(
  { component: StoreDetailRoute },
);
function StoreDetailRoute() {
  return <ProviderStoreDetailPage {...Route.useParams()} />;
}
