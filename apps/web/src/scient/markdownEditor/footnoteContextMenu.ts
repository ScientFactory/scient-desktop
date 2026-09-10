import type { ContextMenuItem } from "@t3tools/contracts";

export type ScientMarkdownFootnoteContextMenuAction =
  | "go-to-footnote"
  | "copy-link"
  | "remove-reference"
  | "delete-footnote";

export interface ScientMarkdownFootnoteContextMenuRequest {
  readonly canCopy: boolean;
  readonly editable: boolean;
  readonly hasDefinition: boolean;
  readonly isFinalReference: boolean;
  readonly position: { readonly x: number; readonly y: number };
}

export type ScientMarkdownFootnoteContextMenuHandler = (
  request: ScientMarkdownFootnoteContextMenuRequest,
) => Promise<ScientMarkdownFootnoteContextMenuAction | null>;

/** Footnote markers get document-navigation actions, never ordinary hyperlink editing. */
export function scientMarkdownFootnoteContextMenuItems(
  request: Omit<ScientMarkdownFootnoteContextMenuRequest, "position">,
): readonly ContextMenuItem<ScientMarkdownFootnoteContextMenuAction>[] {
  const items: ContextMenuItem<ScientMarkdownFootnoteContextMenuAction>[] = [];
  if (request.hasDefinition) {
    items.push({ id: "go-to-footnote", label: "Go to footnote" });
    if (request.canCopy) items.push({ id: "copy-link", label: "Copy link to footnote" });
  }
  if (request.editable) {
    items.push({
      id: "remove-reference",
      label: "Remove this reference",
      separatorBefore: items.length > 0,
    });
    if (request.hasDefinition && request.isFinalReference) {
      items.push({ id: "delete-footnote", label: "Delete footnote", destructive: true });
    }
  }
  return items;
}

export async function showScientMarkdownFootnoteContextMenu(
  request: ScientMarkdownFootnoteContextMenuRequest,
  showContextMenu: (
    items: readonly ContextMenuItem<ScientMarkdownFootnoteContextMenuAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<ScientMarkdownFootnoteContextMenuAction | null>,
): Promise<ScientMarkdownFootnoteContextMenuAction | null> {
  const items = scientMarkdownFootnoteContextMenuItems(request);
  if (items.length === 0) return null;
  return showContextMenu(items, request.position);
}
