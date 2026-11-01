import { createFileRoute } from "@tanstack/react-router";

import { AllServersPage } from "../scient/extensions/DiscoverPages";

export const Route = createFileRoute("/_chat/settings/extensions_/all")({
  component: AllServersPage,
});
