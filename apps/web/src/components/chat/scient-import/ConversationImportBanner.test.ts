import type { OrchestrationConversationImport } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ConversationImportProvenanceBadge,
  conversationImportNotice,
} from "./ConversationImportBanner";

const imported: OrchestrationConversationImport = {
  source: "scic",
  exportId: "export-1",
  sourceThreadId: "source-thread",
  packageDigest: `sha256:${"a".repeat(64)}`,
  sourceFormat: "scient-conversation",
  sourceFormatVersion: 1,
  importedAt: "2026-09-28T09:00:00.000Z",
  omissions: [{ _tag: "range-truncated", throughMessageN: 3 }],
};

describe("conversation import provenance notice", () => {
  it("continues to disclose unverified origin and omissions after a provider session starts", () => {
    const notice = conversationImportNotice(imported, true);
    expect(notice.title).toBe("Imported — unverified");
    expect(notice.description).toContain("messages after message 3");
    expect(notice.description).toContain("remains unverified");
    expect(notice.description).not.toContain("Your next message starts");
  });

  it("says when imported times were moved back, and by how much", () => {
    const moved = (timesShiftedMs: number) =>
      conversationImportNotice({ ...imported, timesShiftedMs }).description;
    expect(moved(86_436_000)).toContain(
      "Times are shown 1 day 36 seconds earlier than in the file, because the file's times were later than the moment it was imported.",
    );
    expect(moved(2 * 3_600_000 + 5 * 60_000 + 7_000)).toContain("shown 2 hours 5 minutes earlier");
    expect(moved(1_000)).toContain("shown 1 second earlier");
    expect(moved(250)).toContain("shown less than a second earlier");
    expect(conversationImportNotice(imported).description).not.toContain("Times are shown");
  });

  it("renders a persistent, non-dismissable label for an imported thread after continuation", () => {
    const markup = renderToStaticMarkup(
      createElement(ConversationImportProvenanceBadge, {
        conversationImport: imported,
        sessionStarted: true,
      }),
    );
    expect(markup).toContain('data-conversation-import-provenance="unverified"');
    expect(markup).toContain("Imported — unverified");
    expect(markup).toContain("1 omission");
  });
});
