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

  it("keeps the persisted viewport lifecycle wired to PDF.js view events", () => {
    const source = NodeFS.readFileSync(new URL("./useScientPdfReader.ts", import.meta.url), "utf8");
    expect(source).toContain('eventBus.on("pagesinit"');
    expect(source).toContain('eventBus.on("updateviewarea"');
    expect(source).toContain("viewportSession.restore(");
    expect(source).toContain("viewportSession.completeRestore()");
    expect(source).toContain("viewportSession.snapshot(");
    expect(source).toContain("viewportSession.flush()");
  });
});
