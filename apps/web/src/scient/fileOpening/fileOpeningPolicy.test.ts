import { describe, expect, it } from "vite-plus/test";

import {
  SCIENT_DEFAULT_FILE_EXPLORER_OPEN,
  SCIENT_DEFAULT_RENDER_MARKDOWN,
  resolveInitialFileExplorerOpen,
  resolveHtmlRenderedState,
  shouldOpenInBrowserByDefault,
} from "./fileOpeningPolicy";

describe("Scient file-opening policy", () => {
  it("renders markdown by default for users without a saved preference", () => {
    expect(SCIENT_DEFAULT_RENDER_MARKDOWN).toBe(true);
  });

  it("starts file content without the embedded explorer unless the user chose otherwise", () => {
    expect(SCIENT_DEFAULT_FILE_EXPLORER_OPEN).toBe(false);
    expect(resolveInitialFileExplorerOpen(null)).toBe(false);
    expect(resolveInitialFileExplorerOpen(true)).toBe(true);
    expect(resolveInitialFileExplorerOpen(false)).toBe(false);
  });

  it("opens HTML files in the integrated browser by default", () => {
    expect(shouldOpenInBrowserByDefault("report.html")).toBe(true);
    expect(shouldOpenInBrowserByDefault("output/REPORT.HTM")).toBe(true);
    expect(shouldOpenInBrowserByDefault("report.html?revision=2#results")).toBe(true);
  });

  it("lets an explicit HTML presentation request override without replacing the preference", () => {
    expect(resolveHtmlRenderedState(true, "source")).toBe(false);
    expect(resolveHtmlRenderedState(true, null)).toBe(true);
    expect(resolveHtmlRenderedState(false, null)).toBe(false);
  });

  it("leaves markdown, PDFs, and source files on their existing file surfaces", () => {
    expect(shouldOpenInBrowserByDefault("README.md")).toBe(false);
    expect(shouldOpenInBrowserByDefault("paper.pdf")).toBe(false);
    expect(shouldOpenInBrowserByDefault("src/report.html.ts")).toBe(false);
  });
});
