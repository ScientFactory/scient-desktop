import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef, ServerBrowserDocumentNavigateInput } from "@t3tools/contracts";
import type { BrowserPdfExportLease } from "./browserPdfExportOwner";
import { readServerBrowserDocumentControl } from "./serverBrowserDocumentControl";

/** Navigate the already-open browser owner; never create a replacement rendering session. */
export async function navigateLinkedHtmlPdfSource(input: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly lease: BrowserPdfExportLease;
  readonly authorizedUrl: string;
  readonly navigateNative: (runtimeTabId: string, url: string) => Promise<void>;
  readonly navigateServer: (target: {
    readonly environmentId: ScopedThreadRef["environmentId"];
    readonly input: ServerBrowserDocumentNavigateInput;
  }) => Promise<AtomCommandResult<void, unknown>>;
}): Promise<void> {
  if (input.lease.owner === "desktop") {
    await input.navigateNative(input.runtimeTabId, input.authorizedUrl);
    return;
  }
  const result = await input.navigateServer({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      tabId: input.tabId,
      expectedServerEpoch: input.lease.serverEpoch,
      expectedSourceUrl: input.lease.pageUrl,
      authorizedUrl: input.authorizedUrl,
      ...(readServerBrowserDocumentControl(input.runtimeTabId) ?? {}),
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
}
