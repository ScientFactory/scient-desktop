import { createFileRoute } from "@tanstack/react-router";

import { InstalledPage } from "../scient/extensions/InstalledPage";

export const Route = createFileRoute("/_chat/settings/extensions_/installed")({
  component: InstalledPage,
});
