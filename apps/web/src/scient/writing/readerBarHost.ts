import { createContext, useContext, useEffect, type ReactNode, type RefObject } from "react";

import { attachShortcutHost } from "../keyboard/host";

/**
 * A surface that already has a header row can host the reader controls
 * (sidebar, page, zoom, search, More) inside that row instead of letting them
 * draw a bar of their own.
 */
export interface ReaderBarHost {
  /** Where the controls are drawn. Nothing is drawn while this is null. */
  readonly slot: HTMLElement | null;
  /** Drawn after the zoom controls. */
  readonly afterZoom?: ReactNode;
  /** Drawn after the search field, before the row's free space. */
  readonly afterSearch?: ReactNode;
  /** Drawn first among the controls at the row's end. */
  readonly beforeTrailing?: ReactNode;
  /** Drawn between Search and More. */
  readonly trailing?: ReactNode;
  /** Added to the More menu after the reader's own actions. */
  readonly moreActions?: ReactNode;
  /** Added to the editor's own Document menu, for an editor that has one. */
  readonly documentActions?: ReactNode;
  /** Told when controls start and stop being drawn in the slot. */
  readonly onHosted: (hosted: boolean) => void;
}

export const ReaderBarHostContext = createContext<ReaderBarHost | null>(null);

/**
 * Hosted controls are drawn outside the pane they belong to, so a key pressed
 * while one of them has focus never reaches that pane. This gives the hosted
 * controls the pane's reader shortcuts (zoom, find) as well.
 */
export function useHostedReaderShortcuts(execute: RefObject<(command: string) => boolean>): void {
  const slot = useContext(ReaderBarHostContext)?.slot ?? null;
  useEffect(
    () =>
      slot
        ? attachShortcutHost(slot, "pdf", {
            execute: (command) => execute.current(command),
            accepts: (event, command) =>
              command === "pdf.find" ||
              !(event.target instanceof Element && event.target.closest("input,textarea")),
          })
        : undefined,
    [slot, execute],
  );
}
