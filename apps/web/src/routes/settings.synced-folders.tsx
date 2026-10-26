import { createFileRoute } from "@tanstack/react-router";

import { SyncedFoldersSettings } from "../scient/settings/SyncedFoldersSettings";

export const Route = createFileRoute("/settings/synced-folders")({
  component: SyncedFoldersSettings,
});
