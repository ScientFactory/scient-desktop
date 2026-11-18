import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

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
export function scientMarkdownTableContextMenuItems(
  resolve: MessageResolver = m,
): readonly ContextMenuItem<ScientMarkdownTableContextMenuItemId>[] {
  return [
    { id: "select-table", label: resolve(msg("Select whole table")) },
    {
      id: "table-row-actions",
      label: resolve(msg("Row", { $context: "table row submenu" })),
      children: [
        { id: "add-row-before", label: resolve(msg("Insert row above")) },
        { id: "add-row-after", label: resolve(msg("Insert row below")) },
        {
          id: "delete-row",
          label: resolve(msg("Delete row")),
          destructive: true,
          separatorBefore: true,
        },
      ],
    },
    {
      id: "table-column-actions",
      label: resolve(msg("Column", { $context: "table column submenu" })),
      children: [
        { id: "add-column-before", label: resolve(msg("Insert column before")) },
        { id: "add-column-after", label: resolve(msg("Insert column after")) },
        {
          id: "delete-column",
          label: resolve(msg("Delete column")),
          destructive: true,
          separatorBefore: true,
        },
      ],
    },
    {
      id: "table-alignment-actions",
      label: resolve(msg("Column alignment")),
      children: [
        { id: "align-column-left", label: resolve(msg("Align left")) },
        { id: "align-column-center", label: resolve(msg("Align center")) },
        { id: "align-column-right", label: resolve(msg("Align right")) },
        {
          id: "align-column-default",
          label: resolve(msg("Clear alignment")),
          separatorBefore: true,
        },
      ],
    },
    {
      id: "table-direction-actions",
      label: resolve(msg("Table direction")),
      children: [
        { id: "direction-auto", label: resolve(msg("Auto (detect from table)")) },
        { id: "direction-ltr", label: resolve(msg("Left to right")) },
        { id: "direction-rtl", label: resolve(msg("Right to left")) },
      ],
    },
    {
      id: "delete-table",
      label: resolve(msg("Delete table")),
      destructive: true,
      separatorBefore: true,
    },
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
