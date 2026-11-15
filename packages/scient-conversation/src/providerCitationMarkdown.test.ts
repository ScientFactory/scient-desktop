import { describe, expect, it } from "vite-plus/test";

import { renderProviderCitationMarkdown } from "./providerCitationMarkdown.ts";

// Client code ships unpolyfilled; URL.canParse is missing before Safari 17.
describe("without URL.canParse", () => {
  it("still links web sources and drops the others", () => {
    const { canParse } = URL;
    Reflect.deleteProperty(URL, "canParse");
    try {
      expect(
        renderProviderCitationMarkdown({
          text: "Evidence here. More.",
          citations: [
            { start: 9, end: 13, sourceIds: ["web"] },
            { start: 15, end: 19, sourceIds: ["file"] },
          ],
          sources: [
            { id: "web", url: "https://example.org/evidence", title: "Evidence" },
            { id: "file", url: "file:///etc/passwd" },
          ],
        } as unknown as Parameters<typeof renderProviderCitationMarkdown>[0]),
      ).toBe('Evidence [1](<https://example.org/evidence> "Evidence"). [citation unavailable].');
    } finally {
      URL.canParse = canParse;
    }
  });
});
