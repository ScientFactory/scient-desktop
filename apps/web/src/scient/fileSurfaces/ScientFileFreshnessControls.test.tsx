import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ScientFileFreshnessNotices,
  ScientFileFreshnessStatus,
  ScientFileReloadButton,
} from "./ScientFileFreshnessControls";

describe("ScientFileReloadButton", () => {
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

    expect(markup).toContain('aria-label="Automatic updates paused: reload file"');
  });

  it("disables and announces a pending reload", () => {
    const markup = renderToStaticMarkup(<ScientFileReloadButton isPending onReload={vi.fn()} />);

    expect(markup).toContain('aria-label="Reloading file…"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
  });
});

describe("ScientFileFreshnessStatus", () => {
  const quiet = {
    relativePath: "paper.tex",
    notice: null,
    readError: null,
    saveError: null,
    saveRetryReady: false,
    hasFallbackData: true,
    onCancel: vi.fn(),
    onReload: vi.fn(),
    onRequestOverwrite: vi.fn(),
    onRetrySave: vi.fn(),
    onResolve: vi.fn(),
  };

  it("says nothing is wrong only when the file's session agrees", () => {
    const calm = renderToStaticMarkup(<ScientFileFreshnessStatus {...quiet} pending={false} />);
    expect(calm).toContain('aria-label="File status: Saved"');

    const conflict = renderToStaticMarkup(
      <ScientFileFreshnessStatus {...quiet} pending sessionAttention="conflict" />,
    );
    expect(conflict).toContain('aria-label="File status: File changed on disk"');

    const failure = renderToStaticMarkup(
      <ScientFileFreshnessStatus {...quiet} pending sessionAttention="failure" />,
    );
    expect(failure).toContain('aria-label="File status: Not saved"');

    // Nothing unsaved: only the check of the disk version failed.
    const refresh = renderToStaticMarkup(
      <ScientFileFreshnessStatus {...quiet} pending={false} sessionAttention="refresh" />,
    );
    expect(refresh).toContain('aria-label="File status: The latest file couldn’t be loaded"');
    expect(refresh).not.toContain("Not saved");

    // A file that never loaded is not "Saved", even with no earlier copy on screen.
    const neverLoaded = renderToStaticMarkup(
      <ScientFileFreshnessStatus
        {...quiet}
        pending={false}
        readError="Failed to read"
        hasFallbackData={false}
      />,
    );
    expect(neverLoaded).toContain('aria-label="File status: The latest file couldn’t be loaded"');
    expect(neverLoaded).not.toContain('aria-label="File status: Saved"');
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
