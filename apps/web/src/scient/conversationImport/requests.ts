import type { DesktopOpenedConversationFile } from "@t3tools/contracts";
import { create } from "zustand";

export type ConversationImportSource =
  | { readonly _tag: "choose" }
  | { readonly _tag: "browser-file"; readonly file: File }
  | { readonly _tag: "desktop-file"; readonly file: DesktopOpenedConversationFile };

type ConversationImportRequest = {
  readonly id: number;
  readonly source: ConversationImportSource;
};

export const useConversationImportRequests = create<{
  readonly nextId: number;
  readonly queue: ReadonlyArray<ConversationImportRequest>;
  /**
   * True while an import dialog is on screen and not committing an import:
   * only then does a dropped file replace the first request's file.
   */
  readonly replaceable: boolean;
}>(() => ({ nextId: 0, queue: [], replaceable: false }));

/** Queues an import. The first request in the queue is the open dialog. */
export function requestConversationImport(
  source: ConversationImportSource = { _tag: "choose" },
): void {
  useConversationImportRequests.setState((state) => ({
    nextId: state.nextId + 1,
    queue: [...state.queue, { id: state.nextId, source }],
  }));
}

/** Gives the open dialog another file; it discards the file it was checking. */
export function replaceConversationImportSource(source: ConversationImportSource): void {
  useConversationImportRequests.setState((state) => {
    const [open, ...waiting] = state.queue;
    return open === undefined ? state : { queue: [{ ...open, source }, ...waiting] };
  });
}

/** A dropped file goes to the open import dialog, or waits its turn when none can take it. */
export function dropConversationImportFile(file: File): void {
  const { queue, replaceable } = useConversationImportRequests.getState();
  const source = { _tag: "browser-file", file } as const;
  if (replaceable && queue.length > 0) replaceConversationImportSource(source);
  else requestConversationImport(source);
}

export function setConversationImportReplaceable(replaceable: boolean): void {
  useConversationImportRequests.setState({ replaceable });
}

export function dismissConversationImportRequest(): void {
  useConversationImportRequests.setState((state) => ({ queue: state.queue.slice(1) }));
}
