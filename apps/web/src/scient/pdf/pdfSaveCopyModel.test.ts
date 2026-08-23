import { describe, expect, it } from "vite-plus/test";

import { presentPdfSaveCopyResult } from "./pdfSaveCopyModel";

describe("presentPdfSaveCopyResult", () => {
  it("reports confirmed desktop saves and browser download starts truthfully", () => {
    expect(presentPdfSaveCopyResult({ _tag: "saved", path: "/tmp/report.pdf" })).toEqual({
      _tag: "notice",
      type: "success",
      title: "PDF saved",
      refreshSource: false,
    });
    expect(presentPdfSaveCopyResult({ _tag: "download-started" })).toEqual({
      _tag: "notice",
      type: "success",
      title: "PDF download started",
      refreshSource: false,
    });
  });

  it("keeps cancellation silent", () => {
    expect(presentPdfSaveCopyResult({ _tag: "cancelled" })).toEqual({
      _tag: "none",
      refreshSource: false,
    });
  });

  it.each(["source-unavailable", "source-changed"] as const)(
    "refreshes an invalidated source after %s",
    (reason) => {
      expect(presentPdfSaveCopyResult({ _tag: "failed", reason }).refreshSource).toBe(true);
    },
  );

  it.each(["dialog-failed", "network-failed", "write-failed"] as const)(
    "does not refresh a healthy source after %s",
    (reason) => {
      const presentation = presentPdfSaveCopyResult({ _tag: "failed", reason });
      expect(presentation._tag).toBe("notice");
      expect(presentation.refreshSource).toBe(false);
    },
  );
});
