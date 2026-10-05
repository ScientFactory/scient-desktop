import type { QueuedRunEdit } from "../state/queued-run-edit";
import { prepareTurnAttachments } from "./attachmentUpload";

/** A queued edit sends its retained server references beside the new local bytes. */
export function prepareQueuedRunEditAttachments(
  input: Omit<Parameters<typeof prepareTurnAttachments>[0], "retainedAttachments"> & {
    readonly edit: Pick<QueuedRunEdit, "existingAttachments">;
  },
) {
  const { edit, ...preparation } = input;
  return prepareTurnAttachments({
    ...preparation,
    retainedAttachments: edit.existingAttachments,
  });
}
