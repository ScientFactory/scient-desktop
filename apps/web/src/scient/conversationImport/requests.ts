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
}>(() => ({ nextId: 0, queue: [] }));

export function requestConversationImport(
  source: ConversationImportSource = { _tag: "choose" },
): void {
  useConversationImportRequests.setState((state) => ({
    nextId: state.nextId + 1,
    queue: [...state.queue, { id: state.nextId, source }],
  }));
}

export function dismissConversationImportRequest(): void {
  useConversationImportRequests.setState((state) => ({ queue: state.queue.slice(1) }));
}
