import type { MouseEvent } from "react";

/** A row's own controls, including options in popups that render elsewhere but bubble here. */
const ROW_CONTROLS =
  "button, a, input, select, [role='switch'], [role='combobox'], [role='option']";

export const OPENABLE_ROW_CLASS = "cursor-pointer transition-colors hover:bg-foreground/[0.025]";

/**
 * Opens a skill's card from a click anywhere on its row except the row's own
 * controls or the end of a text selection. The name stays a button for keyboards.
 */
export function openFromRow(onOpen: () => void) {
  return (event: MouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest(ROW_CONTROLS) !== null) return;
    if (window.getSelection()?.toString()) return;
    onOpen();
  };
}
