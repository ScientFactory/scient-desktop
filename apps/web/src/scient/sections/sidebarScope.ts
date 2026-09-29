import type { ThreadSectionProjectRef } from "@t3tools/contracts";

/**
 * The sidebar's selected project, for section creation outside the sidebar
 * (the chat header's "New section…"), so a section made there is recorded for
 * the same project as one made in the sidebar. Null under All projects or
 * while no sidebar is mounted.
 */
let selectedProjectRefs: readonly ThreadSectionProjectRef[] | null = null;

export function setSidebarSectionScope(refs: readonly ThreadSectionProjectRef[] | null): void {
  selectedProjectRefs = refs;
}

export function readSidebarSectionScope(): readonly ThreadSectionProjectRef[] | null {
  return selectedProjectRefs;
}
