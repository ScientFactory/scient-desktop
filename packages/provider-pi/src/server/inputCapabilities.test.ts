import { assert, describe, it } from "@effect/vitest";
import { ChatAttachmentId, ChatFileAttachment } from "@t3tools/contracts";

import { piHasImageAttachments, piNativeCommandWithAttachments } from "./inputCapabilities.ts";

const attachment = ChatFileAttachment.make({
  id: ChatAttachmentId.make("pi-test-document"),
  type: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 123,
});

describe("Pi input capabilities", () => {
  it("keeps SVG and other file images out of native image delivery", () => {
    assert.isFalse(
      piHasImageAttachments([{ ...attachment, name: "plot.svg", mimeType: "image/svg+xml" }]),
    );
    assert.isFalse(
      piHasImageAttachments([{ ...attachment, name: "plot.png", mimeType: "image/png" }]),
    );
    assert.isTrue(
      piHasImageAttachments([
        { ...attachment, type: "image", name: "plot.png", mimeType: "image/png" },
      ]),
    );
  });

  it("rejects a user-entered discovered slash command with attachments", () => {
    assert.isTrue(
      piNativeCommandWithAttachments("/review this", [attachment], new Set(["review"])),
    );
  });
});
