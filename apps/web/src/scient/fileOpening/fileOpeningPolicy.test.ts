import { describe, expect, it } from "vite-plus/test";

import { SCIENT_DEFAULT_RENDER_MARKDOWN, shouldOpenInBrowserByDefault } from "./fileOpeningPolicy";

describe("Scient file-opening policy", () => {
  it("renders markdown by default for users without a saved preference", () => {
    expect(SCIENT_DEFAULT_RENDER_MARKDOWN).toBe(true);
  });

  it("opens HTML files in the integrated browser by default", () => {
    expect(shouldOpenInBrowserByDefault("report.html")).toBe(true);
    expect(shouldOpenInBrowserByDefault("output/REPORT.HTM")).toBe(true);
    expect(shouldOpenInBrowserByDefault("report.html?revision=2#results")).toBe(true);
  });

  it("leaves markdown, PDFs, and source files on their existing file surfaces", () => {
    expect(shouldOpenInBrowserByDefault("README.md")).toBe(false);
    expect(shouldOpenInBrowserByDefault("paper.pdf")).toBe(false);
    expect(shouldOpenInBrowserByDefault("src/report.html.ts")).toBe(false);
  });
});
