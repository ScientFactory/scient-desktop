import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScientFileReloadButton } from "./ScientFileFreshnessControls";

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
