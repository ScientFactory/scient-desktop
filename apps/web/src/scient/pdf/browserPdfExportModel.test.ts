import { EnvironmentFilePath, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { browserExportLogicalDocumentKey, browserExportReceiptUrl } from "./browserPdfExportModel";

describe("browser PDF export page identity", () => {
  it("ignores renewable local asset capabilities", () => {
    const first =
      "http://127.0.0.1:16491/api/assets/first-token/report.html?capability=first#section";
    const renewed =
      "http://127.0.0.1:16491/api/assets/second-token/report.html?capability=second#other";

    expect(browserExportLogicalDocumentKey(first)).toBe(browserExportLogicalDocumentKey(renewed));
    expect(browserExportReceiptUrl(first)).toBe(
      "http://127.0.0.1:16491/api/assets/%3Csigned%3E/report.html",
    );
  });

  it("does not collapse ordinary web asset paths", () => {
    expect(
      browserExportLogicalDocumentKey("https://example.test/assets/report-a/index.html"),
    ).not.toBe(browserExportLogicalDocumentKey("https://example.test/assets/report-b/index.html"));
  });

  it("uses tracked source identity instead of a renewable local URL", () => {
    const first = {
      _tag: "environment-html" as const,
      environmentId: EnvironmentId.make("environment-1"),
      canonicalPath: EnvironmentFilePath.make("/tmp/one/report.html"),
    };
    const second = {
      ...first,
      canonicalPath: EnvironmentFilePath.make("/tmp/two/report.html"),
    };
    const renewableUrl = "http://127.0.0.1:16491/api/assets/token/report.html";

    expect(browserExportLogicalDocumentKey(renewableUrl, first)).not.toBe(
      browserExportLogicalDocumentKey(renewableUrl, second),
    );
    expect(browserExportLogicalDocumentKey("https://irrelevant.test", first)).toBe(
      browserExportLogicalDocumentKey(renewableUrl, first),
    );
  });

  it("removes credentials and receipt-only URL state", () => {
    expect(
      browserExportReceiptUrl("https://user:secret@example.test/report?token=private#page-2"),
    ).toBe("https://example.test/report");
    expect(browserExportReceiptUrl("not a URL")).toBe("browser-page");
  });
});
