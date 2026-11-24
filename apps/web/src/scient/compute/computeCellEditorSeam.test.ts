// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
// The inherited editor and the Scient modules its marked lines call.
const fileEditorSource = [
  "../../components/files/FilePreviewPanel.tsx",
  "../fileSurfaces/StaticTextFileSurface.tsx",
  "../fileSurfaces/scientFileEditorBindings.tsx",
]
  .map((path) => NodeFS.readFileSync(NodePath.join(here, path), "utf8"))
  .join("\n");
const pythonSurfaceSource = NodeFS.readFileSync(
  NodePath.join(here, "ScientComputeFileSurface.tsx"),
  "utf8",
);

describe("Python active-cell editor seam", () => {
  // regression: eed0733208 feat(compute): implement Phase 4 scientific workflow
  it("uses one Pierre gutter utility API for the run-cell action", () => {
    // Only the hooks the two sides share; styling belongs to the editor.
    expect(fileEditorSource).toContain("{ onGutterUtilityClick: handleGutterUtilityClick }");
    expect(pythonSurfaceSource).toContain("renderEditorGutterAction: (");
    expect(pythonSurfaceSource).toContain('gutterUtilityVisibility="hover"');
    expect(pythonSurfaceSource).not.toContain("enableFileComments={false}");
  });
});
