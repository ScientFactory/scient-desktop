import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export type ScientMarkdownLinkContextMenuAction =
  | "open"
  | "copy-link"
  | "copy-full-path"
  | "edit"
  | "remove";
export type ScientMarkdownLinkKind = "link" | "wiki-link";
export type ScientMarkdownLinkCopyFormat = "link" | "full-path";

export interface ScientMarkdownLinkCopyRequest {
  readonly format: ScientMarkdownLinkCopyFormat;
  readonly value: string;
}

export interface ScientMarkdownLinkContextMenuRequest {
  readonly canCopy: boolean;
  readonly canOpen: boolean;
  readonly editable: boolean;
  readonly fullPath: string | null;
  readonly kind: ScientMarkdownLinkKind;
  readonly position: { readonly x: number; readonly y: number };
  readonly target: string;
}

/** Keep both link types on one small, native app menu without duplicating either editor. */
export function scientMarkdownLinkContextMenuItems(
  request: Pick<
    ScientMarkdownLinkContextMenuRequest,
    "canCopy" | "canOpen" | "editable" | "fullPath" | "kind"
  >,
  resolve: MessageResolver = m,
): readonly ContextMenuItem<ScientMarkdownLinkContextMenuAction>[] {
  const wikiLink = request.kind === "wiki-link";
  const items: ContextMenuItem<ScientMarkdownLinkContextMenuAction>[] = [];
  if (request.canOpen) {
    items.push({
      id: "open",
      label: wikiLink ? resolve(msg("Open linked file")) : resolve(msg("Open link")),
    });
  }
  if (request.canCopy) {
    items.push({ id: "copy-link", label: resolve(msg("Copy link")) });
    if (request.fullPath !== null) {
      items.push({ id: "copy-full-path", label: resolve(msg("Copy full path")) });
    }
  }
  if (request.editable) {
    items.push({
      id: "edit",
      label: wikiLink ? resolve(msg("Edit wiki link")) : resolve(msg("Edit link")),
      separatorBefore: items.length > 0,
    });
    items.push({
      id: "remove",
      label: wikiLink ? resolve(msg("Remove wiki link")) : resolve(msg("Remove link")),
    });
  }
  return items;
}

export async function showScientMarkdownLinkContextMenu(
  request: ScientMarkdownLinkContextMenuRequest,
  showContextMenu: (
    items: readonly ContextMenuItem<ScientMarkdownLinkContextMenuAction>[],
    position: { readonly x: number; readonly y: number },
  ) => Promise<ScientMarkdownLinkContextMenuAction | null>,
): Promise<ScientMarkdownLinkContextMenuAction | null> {
  const items = scientMarkdownLinkContextMenuItems(request);
  if (items.length === 0) return null;
  return showContextMenu(items, request.position);
}
