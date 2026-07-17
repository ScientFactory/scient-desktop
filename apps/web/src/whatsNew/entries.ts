// FILE: entries.ts
// Purpose: Defines the PapiLab release notes shown in the app.
// Layer: Web application release communication.

import type { WhatsNewEntry } from "./logic";

// Upstream Synara release notes are intentionally not user-facing PapiLab
// content. Populate this list only when PapiLab ships its own reviewed release.
export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [];
