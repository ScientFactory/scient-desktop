// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the remote asset seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const fileSurfaceSource = NodeFS.readFileSync(
  new URL("./ScientMarkdownFileSurface.tsx", import.meta.url),
  "utf8",
);

describe("Scient Markdown image asset seam", () => {
  it("inserts only the portable server-returned Markdown path", () => {
    expect(fileSurfaceSource).toContain("src: result.markdownSource");
    expect(fileSurfaceSource).not.toContain("URL.createObjectURL");
  });
});
