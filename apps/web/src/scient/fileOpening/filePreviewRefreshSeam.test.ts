// @effect-diagnostics nodeBuiltinImport:off -- Static audit for narrow inherited viewer seams.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const filePreviewPanelSource = NodeFS.readFileSync(
  new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
  "utf8",
);

describe("Scient file refresh seams", () => {
  it("keeps exact-file freshness in one Scient-owned module", () => {
    expect(NodeFS.existsSync(new URL("./environmentFileChanges.ts", import.meta.url))).toBe(true);
    expect(
      NodeFS.existsSync(new URL("../documentExport/environmentFileChanges.ts", import.meta.url)),
    ).toBe(false);
  });

  it("keeps workspace watcher recovery behind the existing narrow viewer seam", () => {
    // A file owned by a document session reports the health of that session's watcher.
    expect(filePreviewPanelSource).toContain(
      "automaticRefreshUnavailable={automaticRefreshUnavailable || sessionWatch.unavailable}",
    );
    expect(filePreviewPanelSource).toContain("sessionWatch.refresh();");
  });
});
