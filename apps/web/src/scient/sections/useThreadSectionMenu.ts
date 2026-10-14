import type { ContextMenuItem, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";
import type { SectionCreateAnchor } from "./NewSectionPopover";

import { readEnvironmentSupportsSections, useThreadSectionActions } from "./actions";
import { useThreadSectionCatalogs } from "./catalog";
import { sectionGroupId } from "./logic";
import { buildSectionSubmenu, parseSectionMenuAction, type SectionMenuId } from "./menu";

/**
 * The Section submenu for thread context menus (sidebar rows, multi-select and
 * the chat header): building it for the clicked threads and handling its ids.
 * Threads join sections of their own environment, so the submenu lists one
 * environment's sections; a selection spanning environments offers only
 * General and a new section (created on each of their environments).
 */
export function useThreadSectionMenu(
  onRequestNewSection: (
    threadRefs: readonly ScopedThreadRef[],
    anchor: SectionCreateAnchor,
  ) => void,
) {
  const { catalogFor } = useThreadSectionCatalogs();
  const { moveThreadsToSection } = useThreadSectionActions();

  /** Null when any thread's server can't take sections. */
  const menuFor = useCallback(
    (
      threads: ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly sectionId?: string | null | undefined;
      }>,
    ): ContextMenuItem<SectionMenuId> | null => {
      if (
        threads.length === 0 ||
        !threads.every(
          (thread) =>
            readEnvironmentSupportsSections(thread.environmentId) &&
            catalogFor(thread.environmentId) !== null,
        )
      ) {
        return null;
      }
      const environmentIds = new Set(threads.map((thread) => thread.environmentId));
      const shared = environmentIds.size === 1 ? catalogFor(threads[0]!.environmentId) : null;
      return buildSectionSubmenu({
        sections: shared?.sections ?? [],
        generalIndex: shared?.generalIndex ?? 0,
        // Ids a thread's own catalog doesn't hold read as General; across
        // environments, each section is named with its environment.
        currentSectionIds: threads.map((thread) => {
          const sectionId = thread.sectionId ?? null;
          const known =
            sectionId !== null &&
            (catalogFor(thread.environmentId)?.sections.some(
              (section) => section.id === sectionId,
            ) ??
              false);
          if (!known) return null;
          return shared !== null
            ? sectionId
            : sectionGroupId({ environmentId: thread.environmentId, sectionId });
        }),
      });
    },
    [catalogFor],
  );

  /** Resolves true when the clicked id belonged to the Section submenu. */
  const handleMenuAction = useCallback(
    async (
      menuId: string | null,
      threadRefs: readonly ScopedThreadRef[],
      anchor: SectionCreateAnchor,
    ) => {
      const action = menuId === null ? null : parseSectionMenuAction(menuId);
      if (action === null) return false;
      if (action.kind === "new") onRequestNewSection(threadRefs, anchor);
      else if (action.kind === "remove") await moveThreadsToSection(threadRefs, null);
      else {
        // The submenu lists sections only when every thread shares an environment.
        const environmentId = threadRefs[0]?.environmentId;
        if (environmentId !== undefined) {
          await moveThreadsToSection(threadRefs, { environmentId, sectionId: action.sectionId });
        }
      }
      return true;
    },
    [moveThreadsToSection, onRequestNewSection],
  );

  return { menuFor, handleMenuAction };
}
