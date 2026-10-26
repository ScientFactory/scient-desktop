import type { ContextMenuItem, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import type { SectionCreateAnchor } from "./NewSectionPopover";

import { readEnvironmentSupportsSections, useThreadSectionActions } from "./actions";
import { useThreadSectionCatalogs } from "./catalog";
import { sectionGroupId } from "./logic";
import { buildSectionSubmenu, parseSectionMenuAction, type SectionMenuId } from "./menu";

/**
 * Thread sections belong to their own environment. Cross-environment selections may offer only
 * General or a new section created separately in each environment.
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
  const menuFor = (
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
          (catalogFor(thread.environmentId)?.sections.some((section) => section.id === sectionId) ??
            false);
        if (!known) return null;
        return shared !== null
          ? sectionId
          : sectionGroupId({ environmentId: thread.environmentId, sectionId });
      }),
    });
  };

  /** Resolves true when the clicked id belonged to the Section submenu. */
  const handleMenuAction = async (
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
  };

  return { menuFor, handleMenuAction };
}
