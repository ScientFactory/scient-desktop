import { createFileRoute } from "@tanstack/react-router";
import { ProviderStorePage } from "../scient/extensions/ProviderStorePages";
export const Route = createFileRoute("/_chat/settings/extensions_/store/$instanceId")({
  component: StoreRoute,
});
function StoreRoute() {
  return <ProviderStorePage instanceId={Route.useParams().instanceId} />;
}
