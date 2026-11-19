import { createFileRoute } from "@tanstack/react-router";

import { AccountServiceDetailPage } from "../scient/extensions/AccountServicePages";

function SettingsExtensionsAccountServiceRoute() {
  const { serviceId } = Route.useParams();
  return <AccountServiceDetailPage serviceId={serviceId} />;
}

export const Route = createFileRoute("/_chat/settings/extensions_/item/account/$serviceId")({
  component: SettingsExtensionsAccountServiceRoute,
});
