import type { ContextMenuItem } from "@t3tools/contracts";

import type { ScientRichFenceContextMenuAction } from "~/scient/presentation/RichFenceSourceActions";

const RICH_FENCE_CONTEXT_MENU_ITEMS = [
  { id: "edit-source", label: "Edit source" },
  { id: "copy-source", label: "Copy source" },
] as const satisfies readonly ContextMenuItem<ScientRichFenceContextMenuAction>[];

export function richFenceContextMenuItems(): readonly ContextMenuItem<ScientRichFenceContextMenuAction>[] {
  return RICH_FENCE_CONTEXT_MENU_ITEMS;
}

export function showScientRichFenceContextMenu(
  position: { readonly x: number; readonly y: number },
  showContextMenu: (
    items: readonly ContextMenuItem<ScientRichFenceContextMenuAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<ScientRichFenceContextMenuAction | null>,
): Promise<ScientRichFenceContextMenuAction | null> {
  return showContextMenu(RICH_FENCE_CONTEXT_MENU_ITEMS, position);
}
