import { describe, expect, it } from "vite-plus/test";
import { resolveBrowserPdfExportOwner } from "./browserPdfExportOwnerModel";

describe("current-page PDF renderer ownership", () => {
  const remote = {
    runtime: "server" as const,
    nativeServerTab: false,
    hasWebContents: false,
    desktopAvailable: true,
    supportsServerPdf: true,
    serverEpoch: "remote-process",
  };
  it("uses a remote server renderer even from Electron without a local webview", () => {
    expect(resolveBrowserPdfExportOwner(remote)).toBe("server");
    expect(resolveBrowserPdfExportOwner({ ...remote, desktopAvailable: false })).toBe("server");
  });
  it("keeps the primary native server tab on its existing desktop renderer", () => {
    expect(
      resolveBrowserPdfExportOwner({ ...remote, nativeServerTab: true, hasWebContents: true }),
    ).toBe("desktop");
  });
  it("does not substitute the desktop for an old remote server lacking PDF capability or identity", () => {
    expect(
      resolveBrowserPdfExportOwner({ ...remote, supportsServerPdf: false, hasWebContents: true }),
    ).toBeNull();
    expect(resolveBrowserPdfExportOwner({ ...remote, serverEpoch: null })).toBeNull();
  });
  it("requires an actual mounted webview for native and legacy desktop tabs", () => {
    expect(resolveBrowserPdfExportOwner({ ...remote, nativeServerTab: true })).toBeNull();
    expect(
      resolveBrowserPdfExportOwner({ ...remote, runtime: "desktop", hasWebContents: true }),
    ).toBe("desktop");
  });
});
