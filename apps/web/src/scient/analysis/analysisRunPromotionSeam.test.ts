// @effect-diagnostics nodeBuiltinImport:off -- static audit for the Scient-owned analysis UI seam.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";

describe("analysis result promotion UI seam", () => {
  it("keeps promotion in the Scient panel and opens the ordinary project file surface", () => {
    const source = NodeFS.readFileSync(
      new URL("./AnalysisRunFilePanel.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("Save to project");
    expect(source).toContain("analysisEnvironment.promoteRun");
    expect(source).toContain("openFile(props.threadRef, result.value.readmeRelativePath)");

    const inheritedViewer = NodeFS.readFileSync(
      new URL("../../components/files/FilePreviewPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(inheritedViewer).not.toMatch(/promoteRun|Save to project|manifest\.json/gu);
  });
});
