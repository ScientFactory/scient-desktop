// @effect-diagnostics nodeBuiltinImport:off -- Static seam audit for the source-neutral reader.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient PDF reader source seam", () => {
  it("does not grow producer or raw-path branches", () => {
    const source = NodeFS.readFileSync(new URL("./ScientPdfReader.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/browser-export|latex|typst|quarto/iu);
    expect(source).not.toContain("absolutePath");
    expect(source).toContain("PdfSourceDescriptor");
    expect(source).toContain("PdfSourceResolver");
  });
});
