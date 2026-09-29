import { type ContextMenuItem, type ThreadSection, ThreadSectionId } from "@t3tools/contracts";

import { sectionLayoutOrder } from "./logic";

/** Ids contributed to thread context menus by the Section submenu. */
export type SectionMenuId = "section" | "section:new" | "section:remove" | `section:set:${string}`;

export type SectionMenuAction =
  | { readonly kind: "set"; readonly sectionId: ThreadSectionId }
  | { readonly kind: "new" }
  | { readonly kind: "remove" };

/**
 * The Section submenu for one or more threads, listing General and every
 * section in sidebar order. The current choice is checked only when every
 * selected thread shares it; choosing General removes the section.
 */
export function buildSectionSubmenu(input: {
  readonly sections: readonly ThreadSection[];
  readonly generalIndex: number;
  /** Each selected thread's section id (null when unsectioned). */
  readonly currentSectionIds: ReadonlyArray<string | null>;
}): ContextMenuItem<SectionMenuId> {
  const count = input.currentSectionIds.length;
  const known = new Set<string>(input.sections.map((section) => section.id));
  const current = new Set(
    input.currentSectionIds.map((id) => (id !== null && known.has(id) ? id : null)),
  );
  const shared = current.size === 1 ? [...current][0]! : undefined;
  const byId = new Map(input.sections.map((section) => [section.id as string, section]));
  const choices = sectionLayoutOrder(input.sections, input.generalIndex).map((id) => {
    const section = byId.get(id);
    return section
      ? {
          id: `section:set:${section.id}` as const,
          label: section.name,
          checked: shared === section.id,
        }
      : { id: "section:remove" as const, label: "General", checked: shared === null };
  });
  return {
    id: "section",
    label: count > 1 ? `Move to section (${count})` : "Section",
    icon: "list-filter",
    children: [
      ...choices,
      { id: "section:new" as const, label: "New section…", separatorBefore: true },
    ],
  };
}

export function parseSectionMenuAction(id: string): SectionMenuAction | null {
  if (id === "section:new") return { kind: "new" };
  if (id === "section:remove") return { kind: "remove" };
  if (id.startsWith("section:set:")) {
    return { kind: "set", sectionId: ThreadSectionId.make(id.slice("section:set:".length)) };
  }
  return null;
}
