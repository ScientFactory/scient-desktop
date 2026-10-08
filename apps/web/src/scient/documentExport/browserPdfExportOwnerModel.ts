import type { PreviewSessionSnapshot } from "@t3tools/contracts";

export type BrowserPdfExportOwner = "desktop" | "server";

/** A streamed server tab must be printed by that server, even when Electron is available. */
export function resolveBrowserPdfExportOwner(input: {
  readonly runtime: PreviewSessionSnapshot["runtime"];
  readonly nativeServerTab: boolean;
  readonly hasWebContents: boolean;
  readonly desktopAvailable: boolean;
  readonly supportsServerPdf: boolean;
  readonly serverEpoch: string | null;
}): BrowserPdfExportOwner | null {
  if (input.runtime === "server" && !input.nativeServerTab) {
    return input.supportsServerPdf && input.serverEpoch !== null ? "server" : null;
  }
  return input.desktopAvailable && input.hasWebContents ? "desktop" : null;
}
