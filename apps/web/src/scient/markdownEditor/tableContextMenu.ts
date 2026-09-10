import type { ContextMenuItem } from "@t3tools/contracts";

import type { ScientMarkdownCommand } from "./prosemirror/commands";

const TABLE_CONTEXT_MENU_ACTIONS = [
  "select-table",
  "add-row-before",
  "add-row-after",
  "delete-row",
  "add-column-before",
  "add-column-after",
  "delete-column",
  "align-column-left",
  "align-column-center",
  "align-column-right",
  "align-column-default",
  "direction-auto",
  "direction-ltr",
  "direction-rtl",
  "delete-table",
] as const satisfies readonly ScientMarkdownCommand[];

export type ScientMarkdownTableContextMenuAction = (typeof TABLE_CONTEXT_MENU_ACTIONS)[number];

type ScientMarkdownTableContextMenuGroup =
  | "table-row-actions"
  | "table-column-actions"
  | "table-alignment-actions"
  | "table-direction-actions";

type ScientMarkdownTableContextMenuItemId =
  | ScientMarkdownTableContextMenuAction
  | ScientMarkdownTableContextMenuGroup;

const tableContextMenuActions = new Set<string>(TABLE_CONTEXT_MENU_ACTIONS);

export type ScientMarkdownTableContextMenuHandler = (position: {
  readonly x: number;
  readonly y: number;
}) => Promise<ScientMarkdownTableContextMenuAction | null>;

export function isScientMarkdownTableContextMenuAction(
  value: string,
): value is ScientMarkdownTableContextMenuAction {
  return tableContextMenuActions.has(value);
}

/** Native table actions reuse the editor command boundary instead of owning mutations. */
export function scientMarkdownTableContextMenuItems(): readonly ContextMenuItem<ScientMarkdownTableContextMenuItemId>[] {
  return [
    { id: "select-table", label: "Select whole table" },
    {
      id: "table-row-actions",
      label: "Row",
      children: [
        { id: "add-row-before", label: "Insert row above" },
        { id: "add-row-after", label: "Insert row below" },
        { id: "delete-row", label: "Delete row", destructive: true, separatorBefore: true },
      ],
    },
    {
      id: "table-column-actions",
      label: "Column",
      children: [
        { id: "add-column-before", label: "Insert column before" },
        { id: "add-column-after", label: "Insert column after" },
        {
          id: "delete-column",
          label: "Delete column",
          destructive: true,
          separatorBefore: true,
        },
      ],
    },
    {
      id: "table-alignment-actions",
      label: "Column alignment",
      children: [
        { id: "align-column-left", label: "Align left" },
        { id: "align-column-center", label: "Align center" },
        { id: "align-column-right", label: "Align right" },
        { id: "align-column-default", label: "Clear alignment", separatorBefore: true },
      ],
    },
    {
      id: "table-direction-actions",
      label: "Table direction",
      children: [
        { id: "direction-auto", label: "Auto — detect from table" },
        { id: "direction-ltr", label: "Left to right" },
        { id: "direction-rtl", label: "Right to left" },
      ],
    },
    { id: "delete-table", label: "Delete table", destructive: true, separatorBefore: true },
  ];
}

export async function showScientMarkdownTableContextMenu(
  position: { readonly x: number; readonly y: number },
  showContextMenu: (
    items: readonly ContextMenuItem<ScientMarkdownTableContextMenuItemId>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<ScientMarkdownTableContextMenuItemId | null>,
): Promise<ScientMarkdownTableContextMenuAction | null> {
  const selection = await showContextMenu(scientMarkdownTableContextMenuItems(), position);
  return selection !== null && isScientMarkdownTableContextMenuAction(selection) ? selection : null;
}
