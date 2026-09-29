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

/**
 * Gives up a file the operating system opened with Scient once no dialog will
 * send it again: the desktop stops any upload of it and forgets it.
 */
function releaseSource(source: ConversationImportSource | undefined): void {
  if (source?._tag !== "desktop-file") return;
  void Promise.resolve(
    window.desktopBridge?.releaseOpenedConversationFile?.({ token: source.file.token }),
  ).catch(() => undefined);
}

/** Gives the open dialog another file; it discards the file it was checking. */
export function replaceConversationImportSource(source: ConversationImportSource): void {
  const replaced = useConversationImportRequests.getState().queue[0]?.source;
  useConversationImportRequests.setState((state) => {
    const [open, ...waiting] = state.queue;
    return open === undefined ? state : { queue: [{ ...open, source }, ...waiting] };
  });
  if (replaced !== source) releaseSource(replaced);
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

/** Closes the open dialog; the next queued request opens. */
export function dismissConversationImportRequest(): void {
  const dismissed = useConversationImportRequests.getState().queue[0]?.source;
  useConversationImportRequests.setState((state) => ({ queue: state.queue.slice(1) }));
  releaseSource(dismissed);
}
