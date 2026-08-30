// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const panelSource = NodeFS.readFileSync(NodePath.join(here, "ComputePanel.tsx"), "utf8");
const outputSource = NodeFS.readFileSync(NodePath.join(here, "ComputeOutputView.tsx"), "utf8");
const followerSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeFigureFollower.tsx"),
  "utf8",
);
const artifactPreviewSource = NodeFS.readFileSync(
  NodePath.join(here, "../artifacts/ScientArtifactPreview.tsx"),
  "utf8",
);
const artifactViewerActionsSource = NodeFS.readFileSync(
  NodePath.join(here, "../artifacts/staticArtifactViewerActions.ts"),
  "utf8",
);
const artifactMenusSource = NodeFS.readFileSync(
  NodePath.join(here, "../artifacts/StaticArtifactMenus.tsx"),
  "utf8",
);
const imageActionButtonsSource = NodeFS.readFileSync(
  NodePath.join(here, "../../components/preview/StaticImageActionButtons.tsx"),
  "utf8",
);
const pythonActionsSource = NodeFS.readFileSync(
  NodePath.join(here, "PythonFileComputeActions.tsx"),
  "utf8",
);
const pythonSurfaceSource = NodeFS.readFileSync(
  NodePath.join(here, "ScientPythonComputeSurface.tsx"),
  "utf8",
);

describe("compute result surface seam", () => {
  it("keeps editing in the file surface and results focused on outputs", () => {
    const resultSource = `${panelSource}\n${outputSource}`;
    expect(resultSource).not.toContain("Submitted code");
    expect(resultSource).not.toContain("Code that ran");
    expect(resultSource).not.toContain("Run code in this session");
    expect(resultSource).not.toContain("<textarea");
  });

  it("keeps text, errors, figures and live variables in one progressive result surface", () => {
    expect(outputSource).toContain('case "stream"');
    expect(outputSource).toContain('case "diagnostic"');
    expect(outputSource).toContain('case "image"');
    expect(panelSource).toContain("Variables");
    expect(panelSource).toContain("not saved in run history");
    expect(outputSource).toContain("diagnostic.frames");
    expect(outputSource).not.toContain("traceback.match");
    expect(outputSource).not.toContain("File \\\\s+");
  });

  it("keeps Python setup contextual to the file toolbar", () => {
    expect(pythonActionsSource).toContain("resolvePythonRuntimeToolbarState");
    expect(pythonActionsSource).toContain("Open Scientific Computing settings");
    expect(pythonActionsSource).toContain('aria-label="Refresh Python detection"');
    expect(pythonActionsSource).toContain('runtimeToolbar.kind === "switch"');
    expect(pythonActionsSource).toContain("the next run uses the Python selected");
    expect(pythonActionsSource).not.toContain("Settings2");
    expect(panelSource).toContain("!props.embedded && allSessions.length > 0");
  });

  it("keeps the Python file toolbar usable as its panel narrows", () => {
    expect(pythonActionsSource).toContain("@container/python-file-actions");
    expect(pythonActionsSource).toContain("@[9rem]/python-file-actions:block");
    expect(pythonActionsSource).toContain("@[15rem]/python-file-actions:inline");
    expect(pythonActionsSource).toContain("aria-label={primary.label}");
    expect(pythonActionsSource).toContain("Switch Python environment…");
  });

  it("focuses a new run in the session that actually owns it", () => {
    expect(pythonActionsSource).toContain(
      "props.onExecutionSubmitted(session.sessionId, executionId)",
    );
    expect(pythonSurfaceSource).toContain("focusSessionId={focusExecution?.sessionId ?? null}");
    expect(panelSource).toContain("setSelectedSessionId(props.focusSessionId)");
  });

  it("follows only current stable figures through passive generic surfaces", () => {
    expect(panelSource).toContain("selectedIsCurrentResult");
    expect(panelSource).toContain("allowFigureFollowing={selectedIsCurrentResult}");
    expect(outputSource).toContain("computeFigurePresentation");
    expect(outputSource).toContain("StaticArtifactPresentationMenu");
    expect(outputSource).toContain("StaticArtifactPresentationActionMenu");
    expect(outputSource).toContain("StaticImageCopyButton");
    expect(outputSource).toContain("StaticImageDownloadButton");
    expect(outputSource).toContain("artifact={props.presentation.viewer}");
    expect(outputSource).toContain('assetUrl={asset._tag === "Success" ? asset.url : null}');
    expect(artifactMenusSource).toContain("Open in viewer");
    expect(artifactMenusSource).toContain("Floating card");
    expect(imageActionButtonsSource).toContain("Copy image");
    expect(imageActionButtonsSource).toContain("Download original");
    expect(artifactMenusSource).not.toContain("Interactive");
    expect(artifactMenusSource).toContain("toggleStaticArtifactFloating");
    expect(artifactMenusSource).toContain("openStaticArtifactInPanel");
    expect(artifactPreviewSource).toContain("toggleStaticArtifactFloating");
    expect(artifactViewerActionsSource).toContain("openScientArtifact");
    expect(artifactViewerActionsSource).toContain("openArtifact");
    expect(artifactViewerActionsSource).toContain("closeSurface");
    expect(followerSource).toContain("updateScientArtifact");
    expect(followerSource).toContain("updateArtifact");
    expect(followerSource).not.toContain("openScientArtifact");
    expect(followerSource).not.toContain("openArtifact");
    expect(followerSource).toContain("if (events.data?.stale || latestSession === null) return;");
    expect(followerSource).toContain(
      "if (events.data?.stale || latestSession === null) return null;",
    );
  });
});
