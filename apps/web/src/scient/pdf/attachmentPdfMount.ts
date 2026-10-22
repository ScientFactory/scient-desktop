import type { AttachmentPdfLocator } from "@scientfactory/document-artifacts";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

/**
 * Which attachment a chat attachment preview shows, as the identity Scient's
 * reader keeps. Null when there is nothing durable to name, so the preview
 * keeps its generic frame.
 */
export function attachmentPdfMount(input: {
  readonly asset?: { readonly environmentId: EnvironmentId; readonly attachmentId: string };
  readonly sizeBytes?: number;
  readonly threadRef?: ScopedThreadRef;
  readonly file?: Blob | null;
  /** A draft attachment: its composer's thread and its file context id. */
  readonly draftPdf?: { readonly threadRef: ScopedThreadRef; readonly contextId: string };
}): { readonly environmentId: EnvironmentId; readonly locator: AttachmentPdfLocator } | null {
  const draft = input.draftPdf;
  if (draft) {
    if (!input.file && !input.asset) return null;
    return {
      environmentId: input.asset?.environmentId ?? draft.threadRef.environmentId,
      locator: {
        _tag: "draft",
        threadId: draft.threadRef.threadId,
        fileContextId: draft.contextId,
        ...(input.asset ? { uploadedAttachmentId: input.asset.attachmentId } : {}),
      },
    };
  }
  if (!input.asset || !input.threadRef) return null;
  return {
    environmentId: input.asset.environmentId,
    locator: {
      _tag: "sent",
      threadId: input.threadRef.threadId,
      attachmentId: input.asset.attachmentId,
      ...(input.sizeBytes !== undefined && input.sizeBytes >= 1
        ? { sizeBytes: input.sizeBytes }
        : {}),
    },
  };
}
