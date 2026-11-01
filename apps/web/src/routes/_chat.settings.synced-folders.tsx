import { createFileRoute } from "@tanstack/react-router";

import { SyncedFoldersSettings } from "../scient/settings/SyncedFoldersSettings";

export const Route = createFileRoute("/_chat/settings/synced-folders")({
  component: SyncedFoldersSettings,
});
