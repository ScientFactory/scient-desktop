import type { ContextMenuItem, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import type { SectionCreateAnchor } from "./NewSectionPopover";

import { readEnvironmentSupportsSections } from "./actions";
import { useThreadSectionCatalogs } from "./catalog";
import { sectionMenuItem, type SectionMenuId } from "./menu";

/**
 * The thread menu's Move to section entry. A native menu cannot search, so it
 * opens the section picker beside the menu.
 */
export function useThreadSectionMenu(
  onRequestSectionPicker: (
    threadRefs: readonly ScopedThreadRef[],
    anchor: SectionCreateAnchor,
  ) => void,
) {
  const { catalogFor } = useThreadSectionCatalogs();

  /** Null when any thread's server can't take sections. */
  const menuFor = (
    threads: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  ): ContextMenuItem<SectionMenuId> | null =>
    threads.length > 0 &&
    threads.every(
      (thread) =>
        readEnvironmentSupportsSections(thread.environmentId) &&
        catalogFor(thread.environmentId) !== null,
    )
      ? sectionMenuItem(threads.length)
      : null;

  /** True when the clicked id was the Section entry. */
  const handleMenuAction = async (
    menuId: string | null,
    threadRefs: readonly ScopedThreadRef[],
    anchor: SectionCreateAnchor,
  ) => {
    if (menuId !== "section") return false;
    onRequestSectionPicker(threadRefs, anchor);
    return true;
  };

  return { menuFor, handleMenuAction };
}
