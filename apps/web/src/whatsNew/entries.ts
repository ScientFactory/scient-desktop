// FILE: entries.ts
// Purpose: Defines the Scient release notes shown in the app.
// Layer: Web application release communication.

import type { WhatsNewEntry } from "./logic";
import entries from "./entries.json";

// Donor release notes are never user-facing Scient content. Populate this list
// only with Scient-owned copy approved for the exact release candidate.
export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = entries;
