import type { ChatAttachment } from "@t3tools/contracts";
import { prepareTurnAttachments } from "./attachmentUpload";

/** A queued edit sends its retained server references beside the new local bytes. */
export function prepareQueuedRunEditAttachments(
  input: Omit<Parameters<typeof prepareTurnAttachments>[0], "retainedAttachments"> & {
    readonly edit: { readonly existingAttachments: ReadonlyArray<ChatAttachment> };
  },
) {
  const { edit, ...preparation } = input;
  return prepareTurnAttachments({
    ...preparation,
    retainedAttachments: edit.existingAttachments,
  });
}
