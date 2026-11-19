import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import type { ProviderInventoryView } from "./providerInventory";

// Kept apart from providerInventory.ts, which the server's tests import without the web's GT runtime.
export function providerInventoryMessage(
  view: ProviderInventoryView,
  resolve: MessageResolver = m,
): string {
  switch (view.phase) {
    case "unknown":
      return resolve(msg("Agent extensions have not been checked yet."));
    case "checking":
      return resolve(msg("Checking agent extensions across your projects…"));
    case "error":
      return resolve(msg("Could not load agent extensions."));
    case "partial":
      return resolve(msg("Some agent inventories are unavailable. Showing what agents reported."));
    case "ready":
      return resolve(msg("No agent plugins or MCP servers were reported."));
  }
}
