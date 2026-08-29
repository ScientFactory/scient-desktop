import { describe, expect, it, vi } from "vite-plus/test";

import { runHtmlPdfUpdateTransaction } from "./htmlPdfUpdateTransaction";

describe("HTML PDF update transaction", () => {
  it("renews, navigates, accepts the URL, waits, and exports in order", async () => {
    const events: string[] = [];
    const authorizedUrl = "http://127.0.0.1:16491/api/assets/renewed/report.html";

    await runHtmlPdfUpdateTransaction({
      renewAuthorizedUrl: async () => {
        events.push("renew");
        return authorizedUrl;
      },
      navigate: async (url) => {
        expect(url).toBe(authorizedUrl);
        events.push("navigate");
      },
      commitAuthorizedUrl: (url) => {
        expect(url).toBe(authorizedUrl);
        events.push("commit-url");
      },
      waitForReadiness: async () => {
        events.push("ready");
      },
      isNavigationTargetCurrent: () => true,
      isCurrent: () => true,
      hasArtifact: () => true,
      exportPdf: async (url) => {
        expect(url).toBe(authorizedUrl);
        events.push("export");
      },
    });

    expect(events).toEqual(["renew", "navigate", "commit-url", "ready", "export"]);
  });

  it("does not accept or export a URL when navigation fails", async () => {
    const commitAuthorizedUrl = vi.fn();
    const exportPdf = vi.fn(async () => {});

    await expect(
      runHtmlPdfUpdateTransaction({
        renewAuthorizedUrl: async () => "http://127.0.0.1/report.html",
        navigate: async () => {
          throw new Error("navigation failed");
        },
        commitAuthorizedUrl,
        waitForReadiness: async () => {},
        isNavigationTargetCurrent: () => true,
        isCurrent: () => true,
        hasArtifact: () => true,
        exportPdf,
      }),
    ).rejects.toThrow("navigation failed");
    expect(commitAuthorizedUrl).not.toHaveBeenCalled();
    expect(exportPdf).not.toHaveBeenCalled();
  });

  it("rejects an overtaken source generation before publication", async () => {
    let current = true;
    const exportPdf = vi.fn(async () => {});

    await expect(
      runHtmlPdfUpdateTransaction({
        renewAuthorizedUrl: async () => "http://127.0.0.1/report.html",
        navigate: async () => {},
        commitAuthorizedUrl: () => {},
        waitForReadiness: async () => {
          current = false;
        },
        isNavigationTargetCurrent: () => true,
        isCurrent: () => current,
        hasArtifact: () => true,
        exportPdf,
      }),
    ).rejects.toThrow("The HTML source changed again while it was reloading.");
    expect(exportPdf).not.toHaveBeenCalled();
  });

  it("keeps the accepted page URL when the source changes during navigation", async () => {
    let sourceCurrent = true;
    const commitAuthorizedUrl = vi.fn();
    const exportPdf = vi.fn(async () => {});

    await expect(
      runHtmlPdfUpdateTransaction({
        renewAuthorizedUrl: async () => "http://127.0.0.1/report.html",
        navigate: async () => {
          sourceCurrent = false;
        },
        commitAuthorizedUrl,
        waitForReadiness: async () => {},
        isNavigationTargetCurrent: () => true,
        isCurrent: () => sourceCurrent,
        hasArtifact: () => true,
        exportPdf,
      }),
    ).rejects.toThrow("The HTML source changed again while it was reloading.");
    expect(commitAuthorizedUrl).toHaveBeenCalledWith("http://127.0.0.1/report.html");
    expect(exportPdf).not.toHaveBeenCalled();
  });

  it("does not commit a URL after the document moves to another Browser tab", async () => {
    let targetCurrent = true;
    const commitAuthorizedUrl = vi.fn();
    const waitForReadiness = vi.fn(async () => {});

    await expect(
      runHtmlPdfUpdateTransaction({
        renewAuthorizedUrl: async () => "http://127.0.0.1/report.html",
        navigate: async () => {
          targetCurrent = false;
        },
        commitAuthorizedUrl,
        waitForReadiness,
        isNavigationTargetCurrent: () => targetCurrent,
        isCurrent: () => targetCurrent,
        hasArtifact: () => true,
        exportPdf: async () => {},
      }),
    ).rejects.toThrow("The HTML Browser target changed while it was reloading.");
    expect(commitAuthorizedUrl).not.toHaveBeenCalled();
    expect(waitForReadiness).not.toHaveBeenCalled();
  });

  it("does not publish after the linked artifact is removed", async () => {
    const exportPdf = vi.fn(async () => {});

    await runHtmlPdfUpdateTransaction({
      renewAuthorizedUrl: async () => "http://127.0.0.1/report.html",
      navigate: async () => {},
      commitAuthorizedUrl: () => {},
      waitForReadiness: async () => {},
      isNavigationTargetCurrent: () => true,
      isCurrent: () => true,
      hasArtifact: () => false,
      exportPdf,
    });

    expect(exportPdf).not.toHaveBeenCalled();
  });
});
