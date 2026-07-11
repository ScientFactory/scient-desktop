// FILE: whatsNew/entries.ts
// Purpose: Defines LitRev-owned release notes shown in the desktop UI.
// Layer: static data consumed by useWhatsNew, WhatsNewDialog, and ChangelogAccordion.

import type { WhatsNewEntry } from "./logic";

// Upstream Synara release notes are intentionally not user-facing LitRev
// content. Populate this list only when LitRev ships its own reviewed release.
export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [];
