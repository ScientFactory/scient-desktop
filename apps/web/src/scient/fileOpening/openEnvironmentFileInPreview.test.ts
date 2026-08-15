import { describe, expect, it } from "vite-plus/test";

import { environmentFileAssetResource } from "./openEnvironmentFileInPreview";

describe("environment file preview resources", () => {
  it("uses exact capabilities for file surfaces by default", () => {
    expect(environmentFileAssetResource({ path: "/tmp/figure.svg" })).toEqual({
      _tag: "environment-file",
      path: "/tmp/figure.svg",
      access: "exact",
    });
  });

  it("requires an explicit HTML document capability for Browser navigation", () => {
    expect(
      environmentFileAssetResource({ path: "/tmp/interactive.html", access: "html-document" }),
    ).toEqual({
      _tag: "environment-file",
      path: "/tmp/interactive.html",
      access: "html-document",
    });
  });
});
