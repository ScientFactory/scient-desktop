import type { ContextMenuItem } from "@t3tools/contracts";

/** The thread menu's Section entry, which opens the section picker. */
export type SectionMenuId = "section";

export function sectionMenuItem(threadCount: number): ContextMenuItem<SectionMenuId> {
  return {
    id: "section",
    label: threadCount > 1 ? `Move to section (${threadCount})…` : "Move to section…",
    icon: "list-filter",
  };
}
