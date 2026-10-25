import { createFileRoute } from "@tanstack/react-router";

import { DiscoverPage } from "../scient/extensions/DiscoverPages";

export const Route = createFileRoute("/_chat/settings/extensions")({
  component: DiscoverPage,
});
