import { assert, describe, it } from "@effect/vitest";
import { ChatAttachmentId, ChatFileAttachment } from "@t3tools/contracts";

import { piNativeCommandWithAttachments } from "./inputCapabilities.ts";

const attachment = ChatFileAttachment.make({
  id: ChatAttachmentId.make("pi-test-document"),
  type: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123,
});

describe("Pi input capabilities", () => {
  it("rejects a user-entered discovered slash command with attachments", () => {
    assert.isTrue(
      piNativeCommandWithAttachments("/review this", [attachment], new Set(["review"])),
    );
  });
});
