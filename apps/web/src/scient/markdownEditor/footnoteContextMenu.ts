import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

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
  resolve: MessageResolver = m,
): readonly ContextMenuItem<ScientMarkdownFootnoteContextMenuAction>[] {
  const items: ContextMenuItem<ScientMarkdownFootnoteContextMenuAction>[] = [];
  if (request.hasDefinition) {
    items.push({ id: "go-to-footnote", label: resolve(msg("Go to footnote")) });
    if (request.canCopy)
      items.push({ id: "copy-link", label: resolve(msg("Copy link to footnote")) });
  }
  if (request.editable) {
    items.push({
      id: "remove-reference",
      label: resolve(msg("Remove this reference")),
      separatorBefore: items.length > 0,
    });
    if (request.hasDefinition && request.isFinalReference) {
      items.push({
        id: "delete-footnote",
        label: resolve(msg("Delete footnote")),
        destructive: true,
      });
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
