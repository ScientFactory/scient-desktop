import type { ContextMenuItem, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentSupportsSections, useThreadSectionActions } from "./actions";
import { useThreadSectionCatalog } from "./catalog";
import { buildSectionSubmenu, parseSectionMenuAction, type SectionMenuId } from "./menu";

/**
 * The Section submenu for thread context menus (sidebar rows, multi-select and
 * the chat header): building it for the clicked threads and handling its ids.
 */
export function useThreadSectionMenu(
  onRequestNewSection: (threadRefs: readonly ScopedThreadRef[]) => void,
) {
  const { available, generalIndex, sections } = useThreadSectionCatalog();
  const { moveThreadsToSection } = useThreadSectionActions();

  /** Null when the catalog or any thread's server can't take sections. */
  const menuFor = useCallback(
    (
      threads: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly sectionId?: string | null | undefined;
      }>,
    ): ContextMenuItem<SectionMenuId> | null =>
      available &&
      threads.length > 0 &&
      threads.every((thread) => readEnvironmentSupportsSections(thread.environmentId))
        ? buildSectionSubmenu({
            sections,
            generalIndex,
            currentSectionIds: threads.map((thread) => thread.sectionId ?? null),
          })
        : null,
    [available, generalIndex, sections],
  );

  /** Resolves true when the clicked id belonged to the Section submenu. */
  const handleMenuAction = useCallback(
    async (menuId: string | null, threadRefs: readonly ScopedThreadRef[]) => {
      const action = menuId === null ? null : parseSectionMenuAction(menuId);
      if (action === null) return false;
      if (action.kind === "new") onRequestNewSection(threadRefs);
      else await moveThreadsToSection(threadRefs, action.kind === "set" ? action.sectionId : null);
      return true;
    },
    [moveThreadsToSection, onRequestNewSection],
  );

  return { menuFor, handleMenuAction };
}
