import { type ContextMenuItem, type ThreadSection, ThreadSectionId } from "@t3tools/contracts";

/** Ids contributed to thread context menus by the Section submenu. */
export type SectionMenuId = "section" | "section:new" | "section:remove" | `section:set:${string}`;

export type SectionMenuAction =
  | { readonly kind: "set"; readonly sectionId: ThreadSectionId }
  | { readonly kind: "new" }
  | { readonly kind: "remove" };

/**
 * The Section submenu for one or more threads. The current section is checked
 * only when every selected thread shares it. "Remove from section" appears
 * once any selected thread belongs to a section.
 */
export function buildSectionSubmenu(input: {
  readonly sections: readonly ThreadSection[];
  /** Each selected thread's section id (null when unsectioned). */
  readonly currentSectionIds: ReadonlyArray<string | null>;
}): ContextMenuItem<SectionMenuId> {
  const count = input.currentSectionIds.length;
  const known = new Set<string>(input.sections.map((section) => section.id));
  const current = new Set(
    input.currentSectionIds.map((id) => (id !== null && known.has(id) ? id : null)),
  );
  const shared = current.size === 1 ? [...current][0]! : undefined;
  const anyFiled = [...current].some((id) => id !== null);
  return {
    id: "section",
    label: count > 1 ? `Move to section (${count})` : "Section",
    icon: "list-filter",
    separatorBefore: true,
    children: [
      ...input.sections.map((section) => ({
        id: `section:set:${section.id}` as const,
        label: section.name,
        checked: shared === section.id,
      })),
      {
        id: "section:new" as const,
        label: "New section…",
        separatorBefore: input.sections.length > 0,
      },
      ...(anyFiled
        ? [{ id: "section:remove" as const, label: "Remove from section", separatorBefore: true }]
        : []),
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
