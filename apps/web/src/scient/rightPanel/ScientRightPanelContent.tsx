import type {
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { lazy, Suspense, type ReactNode } from "react";

import type { ScientRightPanelSurface } from "./surfaces";

const ScientSourcesPanel = lazy(() =>
  import("../sources/ScientSourcesPanel").then((module) => ({
    default: module.ScientSourcesPanel,
  })),
);
const SourcePdfPreview = lazy(() =>
  import("../sources/SourcePdfPreview").then((module) => ({
    default: module.SourcePdfPreview,
  })),
);
const ScientArtifactPreview = lazy(() =>
  import("../artifacts/ScientArtifactPreview").then((module) => ({
    default: module.ScientArtifactPreview,
  })),
);
const GeneratedPdfPreview = lazy(() =>
  import("../pdf/GeneratedPdfPreview").then((module) => ({
    default: module.GeneratedPdfPreview,
  })),
);
const EnvironmentFilePreview = lazy(() => import("../fileOpening/EnvironmentFilePreview"));
const ScientSkillDocumentPreview = lazy(() =>
  import("../skills/ScientSkillDocumentPreview").then((module) => ({
    default: module.ScientSkillDocumentPreview,
  })),
);
const ComputePanel = lazy(() =>
  import("../compute/ComputePanel").then((module) => ({
    default: module.ComputePanel,
  })),
);

export interface ScientRightPanelContentProps {
  readonly surface: ScientRightPanelSurface;
  readonly activeThreadRef: ScopedThreadRef;
  readonly activeThread: { readonly environmentId: EnvironmentId } | null | undefined;
  readonly activeProject: { readonly title: string } | null | undefined;
  readonly activeWorkspaceRoot: string | undefined;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly closeRightPanelSurface: (surface: ScientRightPanelSurface) => void;
  readonly openScientSourcePdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
}

/**
 * The right-panel content for a Scient-owned surface, or nothing when the
 * surface cannot be shown yet.
 */
export function ScientRightPanelContent(input: ScientRightPanelContentProps): ReactNode {
  const {
    surface: renderedRightPanelSurface,
    activeThreadRef,
    activeThread,
    activeProject,
    activeWorkspaceRoot,
    availableEditors,
    keybindings,
    closeRightPanelSurface,
    openScientSourcePdf,
  } = input;
  return renderedRightPanelSurface?.kind === "scient" &&
    renderedRightPanelSurface.module === "compute" &&
    activeThreadRef ? (
    <Suspense fallback={null}>
      <ComputePanel
        key={`${activeThreadRef.environmentId}:${activeThreadRef.threadId}:${renderedRightPanelSurface.id}`}
        environmentId={activeThreadRef.environmentId}
        cwd={renderedRightPanelSurface.cwd}
        threadRef={activeThreadRef}
        {...(renderedRightPanelSurface.contextId === undefined
          ? {}
          : {
              contextId: renderedRightPanelSurface.contextId,
              onRetryClose: () => closeRightPanelSurface(renderedRightPanelSurface),
            })}
      />
    </Suspense>
  ) : renderedRightPanelSurface?.kind === "scient" &&
    renderedRightPanelSurface.module === "file" &&
    activeThreadRef ? (
    <Suspense fallback={null}>
      <EnvironmentFilePreview
        availableEditors={availableEditors}
        environmentId={activeThreadRef.environmentId}
        keybindings={keybindings}
        surface={renderedRightPanelSurface}
        threadRef={activeThreadRef}
      />
    </Suspense>
  ) : renderedRightPanelSurface?.kind === "scient" &&
    renderedRightPanelSurface.module === "skill" &&
    activeThreadRef ? (
    <Suspense fallback={null}>
      <ScientSkillDocumentPreview
        environmentId={activeThreadRef.environmentId}
        releaseKey={renderedRightPanelSurface.releaseKey}
        threadRef={activeThreadRef}
      />
    </Suspense>
  ) : renderedRightPanelSurface?.kind === "scient" &&
    renderedRightPanelSurface.module === "artifact" ? (
    <Suspense fallback={null}>
      <ScientArtifactPreview
        environmentId={activeThreadRef.environmentId}
        threadRef={activeThreadRef}
        artifact={renderedRightPanelSurface.artifact}
      />
    </Suspense>
  ) : renderedRightPanelSurface?.kind === "scient" &&
    renderedRightPanelSurface.module === "generated-pdf" &&
    activeThreadRef ? (
    <Suspense fallback={null}>
      <GeneratedPdfPreview source={renderedRightPanelSurface.source} threadRef={activeThreadRef} />
    </Suspense>
  ) : renderedRightPanelSurface?.kind === "scient" &&
    renderedRightPanelSurface.module === "source-pdf" &&
    activeThread &&
    activeThreadRef &&
    activeWorkspaceRoot ? (
    <Suspense fallback={null}>
      <SourcePdfPreview
        readerScope={activeThreadRef.threadId}
        attachmentId={renderedRightPanelSurface.attachmentId}
        environmentId={activeThread.environmentId}
        fileName={renderedRightPanelSurface.fileName}
        root={activeWorkspaceRoot}
        sourceId={renderedRightPanelSurface.sourceId}
      />
    </Suspense>
  ) : renderedRightPanelSurface?.kind === "scient" &&
    renderedRightPanelSurface.module === "sources" &&
    activeThread &&
    activeThreadRef &&
    activeProject &&
    activeWorkspaceRoot ? (
    <Suspense fallback={null}>
      <ScientSourcesPanel
        environmentId={activeThread.environmentId}
        root={activeWorkspaceRoot}
        projectTitle={activeProject.title}
        onOpenPdf={openScientSourcePdf}
      />
    </Suspense>
  ) : null;
}
