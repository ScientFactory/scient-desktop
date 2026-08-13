// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited file-panel seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("Scient PDF file-preview seam", () => {
  it("keeps restored file tabs behind the PDF-only source adapter", () => {
    const source = NodeFS.readFileSync(
      new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'import { workspacePdfSourceForPreview } from "~/scient/pdf/pdfSource";',
    );
    expect(source.match(/\bworkspacePdfSourceForPreview\(\{/gu)).toHaveLength(1);
    expect(source).not.toMatch(/\bworkspacePdfSource\(\{/u);
  });
});
