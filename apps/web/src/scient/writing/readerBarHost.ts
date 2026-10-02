import { createContext, type ReactNode } from "react";

/**
 * A surface that already has a header row can host the reader controls
 * (sidebar, page, zoom, search, More) inside that row instead of letting them
 * draw a bar of their own.
 */
export interface ReaderBarHost {
  /** Where the controls are drawn. Nothing is drawn while this is null. */
  readonly slot: HTMLElement | null;
  /** Drawn between Search and More. */
  readonly trailing?: ReactNode;
  /** Added to the More menu after the reader's own actions. */
  readonly moreActions?: ReactNode;
  /** Told when controls start and stop being drawn in the slot. */
  readonly onHosted: (hosted: boolean) => void;
}

export const ReaderBarHostContext = createContext<ReaderBarHost | null>(null);
