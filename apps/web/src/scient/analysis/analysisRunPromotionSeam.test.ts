// @effect-diagnostics nodeBuiltinImport:off -- static audit for the Scient-owned analysis UI seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("analysis result promotion UI seam", () => {
  it("keeps run promotion out of the inherited file viewer", () => {
    const inheritedViewer = NodeFS.readFileSync(
      new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(inheritedViewer).not.toMatch(/promoteRun|Save to project|manifest\.json/gu);
  });
});
