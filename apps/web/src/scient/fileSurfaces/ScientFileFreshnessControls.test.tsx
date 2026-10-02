import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScientFileFreshnessNotices, ScientFileReloadButton } from "./ScientFileFreshnessControls";

describe("ScientFileReloadButton", () => {
  it("renders the normal workspace reload action", () => {
    const markup = renderToStaticMarkup(
      <ScientFileReloadButton isPending={false} onReload={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="Reload file from disk"');
    expect(markup).toContain("lucide-refresh-cw");
    expect(markup).not.toContain("lucide-rotate-cw");
    expect(markup).toMatch(/^<button/u);
    expect(markup).not.toContain("text-warning");
  });

  it("keeps watcher recovery visible in the compact file header", () => {
    const markup = renderToStaticMarkup(
      <ScientFileReloadButton
        automaticRefreshUnavailable
        isPending={false}
        label="Reload file"
        onReload={vi.fn()}
        size="icon-xs"
      />,
    );

    expect(markup).toContain('aria-label="Automatic updates paused — reload file"');
    expect(markup).toContain("text-warning");
  });

  it("disables and announces a pending reload", () => {
    const markup = renderToStaticMarkup(<ScientFileReloadButton isPending onReload={vi.fn()} />);

    expect(markup).toContain('aria-label="Reloading file…"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("animate-spin");
  });
});

describe("ScientFileFreshnessNotices", () => {
  const notices = (
    overrides: Partial<Parameters<typeof ScientFileFreshnessNotices>[0]> = {},
  ): string =>
    renderToStaticMarkup(
      <ScientFileFreshnessNotices
        relativePath="report.txt"
        notice={null}
        readError="Failed to read workspace file"
        saveError={null}
        saveRetryReady={false}
        hasFallbackData
        onCancel={vi.fn()}
        onReload={vi.fn()}
        onRequestOverwrite={vi.fn()}
        onRetrySave={vi.fn()}
        onResolve={vi.fn()}
        {...overrides}
      />,
    );

  it("says an open file is gone and offers where it may have moved", () => {
    const markup = notices({
      readFailureReason: "not_found",
      missingFileChoices: ["archive/report.txt", "old/report.txt", "older/report.txt"],
      onOpenFile: vi.fn(),
    });

    expect(markup).toContain("This file is no longer at this location.");
    expect(markup).toContain("Showing the last available copy.");
    expect(markup).toContain("archive/report.txt");
    expect(markup).toContain("old/report.txt");
    // One line of notice: further candidates wait behind Try again.
    expect(markup).not.toContain("older/report.txt");
    expect(markup).toContain("Try again");
  });

  it("keeps the generic caution, without choices, when the cause is unknown", () => {
    const markup = notices({ missingFileChoices: ["archive/report.txt"], onOpenFile: vi.fn() });

    expect(markup).toContain("The latest version could not be loaded.");
    expect(markup).not.toContain("archive/report.txt");
  });
});
