// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const sessionsSource = NodeFS.readFileSync(
  NodePath.join(here, "useComputePanelSessions.ts"),
  "utf8",
);
const controlsSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeSessionControls.tsx"),
  "utf8",
);
const runEntrySource = NodeFS.readFileSync(NodePath.join(here, "ComputeRunEntry.tsx"), "utf8");
const outputSource = NodeFS.readFileSync(NodePath.join(here, "ComputeOutputView.tsx"), "utf8");
const figureSource = NodeFS.readFileSync(NodePath.join(here, "ComputeFigure.tsx"), "utf8");
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
const imageActionButtonsSource = NodeFS.readFileSync(
  NodePath.join(here, "../../components/preview/StaticImageActionButtons.tsx"),
  "utf8",
);
const pythonActionsSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeFileActions.tsx"),
  "utf8",
);
const pythonSurfaceSource = NodeFS.readFileSync(
  NodePath.join(here, "ScientComputeFileSurface.tsx"),
  "utf8",
);

const managedRuntimeSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeManagedRuntimeControls.tsx"),
  "utf8",
);
const rightPanelTabsSource = NodeFS.readFileSync(
  NodePath.join(here, "../../components/RightPanelTabs.tsx"),
  "utf8",
);

const settingsSource = NodeFS.readFileSync(
  NodePath.join(here, "ScientificComputingSettings.tsx"),
  "utf8",
);
const languagePageSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeLanguagePage.tsx"),
  "utf8",
);
const languagePanelSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeLanguagePanel.tsx"),
  "utf8",
);

describe("compute result surface seam", () => {
  // regression: e28be01e7d fix(compute): tighten runtime truth and authority
  it("keeps one secondary Compute-session command in the add-surface menu", () => {
    const primaryActions = rightPanelTabsSource.slice(
      rightPanelTabsSource.indexOf("const addSurfaceActions"),
      rightPanelTabsSource.indexOf("const extraSessionAction"),
    );
    expect(primaryActions).not.toContain('label: "Compute"');
    expect(primaryActions).not.toContain('label: "Scientific computing"');
    expect(rightPanelTabsSource).toContain('label: "Scientific computing"');
  });

  // regression: 13a5e053d2 chore(compute): checkpoint before main alignment
  it("keys standalone controls by their owner and preserves producing result generations", () => {
    // ChatView mounts the compute panel from the owned right-panel content module.
    const chat = [
      NodeFS.readFileSync(NodePath.join(here, "../../components/ChatView.tsx"), "utf8"),
      NodeFS.readFileSync(NodePath.join(here, "../rightPanel/ScientRightPanelContent.tsx"), "utf8"),
    ].join("\n");
    expect(chat).toContain(
      "key={`${activeThreadRef.environmentId}:${activeThreadRef.threadId}:${renderedRightPanelSurface.id}`}",
    );
    expect(runEntrySource).toContain("executionGeneration={execution.request.generation}");
    const actions = controlsSource.slice(
      controlsSource.indexOf('aria-label="Session actions"'),
      controlsSource.indexOf('aria-label="Session actions"') + 400,
    );
    expect(actions).not.toContain("operation !== null");
    expect(actions).toContain('operation === "stop"');
  });

  // regression: 13a5e053d2 chore(compute): checkpoint before main alignment
  it("captures session command targets by exact session and generation", () => {
    expect(controlsSource).toContain(
      "getComputeContext(props.contextId)?.sessionId !== target.sessionId",
    );
    expect(controlsSource).toContain("sessionId: target.sessionId");
    expect(controlsSource).toContain("expectedGeneration: target.generation");
  });

  // regression: eed0733208 feat(compute): implement Phase 4 scientific workflow
  it("keeps text, errors, figures and live variables in one progressive result surface", () => {
    expect(outputSource).toContain('case "stream"');
    expect(outputSource).toContain('case "diagnostic"');
    expect(outputSource).toContain('case "image"');
    expect(outputSource).toContain("diagnostic.frames");
    expect(outputSource).not.toContain("traceback.match");
    expect(outputSource).not.toContain("File \\\\s+");
  });

  // regression: a015a05c01 fix: harden scientific compute workflows
  it("keeps runtime recovery contextual to the file toolbar", () => {
    expect(pythonActionsSource).toContain("resolveComputeRuntimeToolbarState");
    expect(pythonActionsSource).toContain("Scientific Computing");
    expect(pythonActionsSource).toContain('to="/settings/scientific-computing/$languageId"');
    expect(pythonActionsSource).not.toContain("Check again");
    expect(pythonActionsSource).toContain("computeRuntimeSetupActionLabel");
    expect(pythonActionsSource).toContain('runtimeToolbar.kind === "switch"');
    expect(pythonActionsSource).toContain("replaceComputeContextSession");
    expect(pythonActionsSource).toContain("switchTarget?.label");
    expect(pythonActionsSource).toContain("executable: target.executable");
    expect(pythonActionsSource).not.toContain("Settings2");
    expect(pythonActionsSource).toContain("props.onShowMatlabOneShot");
    expect(pythonActionsSource).toContain("pinRuntimeChrome");
    expect(pythonActionsSource).toContain(
      'props.language.languageId !== "matlab" && !runtimeToolbar.canRun',
    );
  });

  // regression: 0b6af7cc3c feat(compute): add assisted Python setup and runtime recovery
  it("keeps the Python file toolbar usable as its panel narrows", () => {
    expect(pythonSurfaceSource).toContain("flex-wrap items-center gap-x-2 gap-y-1");
    expect(pythonSurfaceSource).toContain('className="min-w-22 flex-1"');
    expect(pythonActionsSource).toContain("@container/python-file-actions");
    expect(pythonActionsSource).toContain("@[9rem]/python-file-actions:flex");
    expect(pythonActionsSource).toContain("@[15rem]/python-file-actions:inline");
    expect(pythonSurfaceSource).toContain("useComputeFilePresentationStore");
    expect(pythonSurfaceSource).toContain(
      "setFileView(props.contextId, computeFileViewAfterRun(currentView, preferredResultsView))",
    );
    expect(pythonSurfaceSource).toContain('setPanelView(props.contextId, "results")');
    expect(pythonActionsSource).toContain("onRunRequested();");
    expect(pythonActionsSource).toContain("Switch {languageName} environment…");
  });

  // regression: 9d11c5ad39 feat(compute): selectively adopt runtime UX improvements
  it("keeps file-header runtime errors to one line with copy and details", () => {
    expect(pythonActionsSource).toContain('variant="toolbar"');
    expect(pythonActionsSource).not.toContain("setupProgress ? null : capacityBlocked");
    expect(pythonActionsSource).not.toContain("connectionSetupFailed:");
    expect(pythonActionsSource).not.toContain("onRetry={() => void handleSetup()}");
    expect(pythonActionsSource).toContain("overflow-hidden");
    expect(pythonActionsSource).toContain('className="flex shrink-0 items-center"');
    expect(managedRuntimeSource).toContain("failure.summary");
    expect(managedRuntimeSource).toContain("failure.detail");
    expect(managedRuntimeSource).toContain('aria-label="Copy error"');
    expect(managedRuntimeSource).toContain("<details");
    expect(managedRuntimeSource).toContain("whitespace-nowrap");
    expect(managedRuntimeSource).not.toContain("title={onRetry");
    expect(managedRuntimeSource).toContain("Copy the full error");
  });

  // regression: 43ee632b0c fix(compute): refresh generated files and tighten narrow layouts
  it("refreshes the current workspace tree after successful or failed executions", () => {
    expect(sessionsSource).toContain(
      "TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)",
    );
    expect(sessionsSource).toContain("refreshProjectFiles(input.environmentId, input.cwd)");
  });

  // regression: 0b6af7cc3c feat(compute): add assisted Python setup and runtime recovery
  it("follows a new run in the session that actually owns it", () => {
    expect(pythonActionsSource).toContain("onExecutionSubmitted(session.sessionId, executionId)");
    expect(pythonSurfaceSource).toContain("focusExecutionId={focusExecution?.executionId ?? null}");
  });

  // regression: f82ba747e0 feat(compute): add language-neutral figure following
  it("follows only current stable figures through passive generic surfaces", () => {
    expect(runEntrySource).toContain("allowFigureFollowing={props.newest}");
    expect(outputSource).toContain("computeFigurePresentation");
    expect(outputSource).toContain("ComputeFigure");
    expect(figureSource).toContain("openStaticArtifactInPanel");
    expect(figureSource).toContain("presentation.viewer");
    expect(figureSource).toContain("presentation.inline.resource");
    expect(figureSource).toContain("ScientImageActionMenu");
    expect(imageActionButtonsSource).toContain("Copy image");
    expect(imageActionButtonsSource).toContain("Download original");
    expect(figureSource).toContain("toggleStaticArtifactFloating");
    expect(figureSource).toContain("Floating card");
    expect(artifactPreviewSource).toContain("StaticImageActionButtons");
    expect(artifactPreviewSource).toContain("toggleStaticArtifactFloating");
    expect(artifactViewerActionsSource).toContain("openScientArtifact");
    expect(artifactViewerActionsSource).toContain("openArtifact");
    expect(artifactViewerActionsSource).toContain("closeSurface");
    expect(followerSource).toContain("updateScientArtifact");
    expect(followerSource).toContain("updateArtifact");
    expect(followerSource).not.toContain("openScientArtifact");
    expect(followerSource).not.toContain("openArtifact");
    expect(followerSource).toContain("if (events.data?.stale || latestSession === null) return;");
    expect(followerSource).toContain("if (events.data?.stale) return null;");
  });
});

// regression: 78962a11ee feat(compute): checkpoint runtime settings and managed package improvements
it("keeps default selection separate from installation actions using shared settings rows", () => {
  expect(languagePageSource).toContain("SettingsRow");
  expect(languagePageSource).toContain("SettingsSection");
  expect(languagePageSource).toContain('variant="plain"');
  expect(languagePageSource).toContain("SettingsSourcePanel");
  expect(settingsSource).not.toContain("Python & MATLAB");
  expect(settingsSource).not.toContain("Advanced");
  expect(languagePanelSource).toContain('title="Runtime"');
  expect(languagePanelSource).toContain("SelectTrigger");
  expect(languagePanelSource).toContain("computeRuntimePickerLabel");
  expect(languagePanelSource).not.toContain("<select");
  expect(languagePanelSource).not.toContain("break-all");
  expect(languagePanelSource).toContain("ManagedRuntimeMaintenanceMenu");
  expect(languagePanelSource).toContain("ComputeInstallationRow");
  expect(settingsSource).not.toContain("coming soon");
  expect(languagePageSource).toContain('title="Scientific Computing"');
  expect(pythonActionsSource).toContain("runtimeVersion:");
});
