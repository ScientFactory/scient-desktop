import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { FileSurfaceFailure, FileSurfaceMessage } from "./fileSurfaceChrome";

describe("file surface states", () => {
  it("announces a failure calmly, with the raw error only behind Details", () => {
    const markup = renderToStaticMarkup(
      <FileSurfaceFailure
        title="Couldn't open this file"
        description="It may have been moved."
        details="ENOENT: no such file or directory, open '/tmp/report.md'"
        onRetry={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Couldn&#x27;t open this file");
    expect(markup).toContain("Try again");
    expect(markup).toContain("Details");
    expect(markup).not.toMatch(/destructive|text-red/u);
    // The disclosure starts closed, so the raw error is not shown by default.
    expect(markup).not.toContain("ENOENT");
  });

  it("shows retry progress and blocks a second request while pending", () => {
    const markup = renderToStaticMarkup(
      <FileSurfaceFailure
        title="Couldn't open this file"
        description=""
        onRetry={vi.fn()}
        retrying
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatch(/<button[^>]*disabled/u);
  });

  it("renders a neutral no-preview state without actions or details", () => {
    const markup = renderToStaticMarkup(
      <FileSurfaceMessage title="Preview unavailable" description="Scient can't preview this." />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Details");
  });
});
