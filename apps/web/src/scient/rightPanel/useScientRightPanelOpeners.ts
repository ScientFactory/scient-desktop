import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import {
  type HtmlFilePresentationRequest,
  type LatexFilePresentationRequest,
  type OpenFileOptions,
  useRightPanelStore,
} from "~/rightPanelStore";
import { createComputeContextId } from "~/scient/compute/computeContextStore";
import { shouldOpenInBrowserByDefault } from "~/scient/fileOpening/fileOpeningPolicy";
import { useScientFileOpening } from "~/scient/fileOpening/useScientFileOpening";
import type { useActivePendingSurfaceDeparture } from "~/scient/fileSurfaces/usePendingSurfaceDeparture";

import {
  scientComputeSurface,
  scientDocumentsSurface,
  scientSourcePdfSurface,
  scientSourcesSurface,
} from "./surfaces";

/**
 * Openers for the right-panel surfaces Scient adds: agents, sources, compute,
 * source PDFs and file sources. Each waits for a pending file save first.
 */
export function useScientRightPanelOpeners(input: {
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly activeProject: object | null | undefined;
  readonly activeWorkspaceRoot: string | undefined;
  readonly runAfterPendingFileSave: ReturnType<typeof useActivePendingSurfaceDeparture>;
}) {
  const { activeThreadRef, activeProject, activeWorkspaceRoot, runAfterPendingFileSave } = input;
  const addAgentsSurface = useCallback(() => {
    if (!activeThreadRef) return;
    runAfterPendingFileSave("agents", () => {
      useRightPanelStore.getState().open(activeThreadRef, "agents");
    });
  }, [activeThreadRef, runAfterPendingFileSave]);
  const addDocumentsSurface = useCallback(() => {
    if (!activeThreadRef || activeWorkspaceRoot === undefined) return;
    const surface = scientDocumentsSurface();
    runAfterPendingFileSave(surface.id, () => {
      useRightPanelStore.getState().openScient(activeThreadRef, surface);
    });
  }, [activeThreadRef, activeWorkspaceRoot, runAfterPendingFileSave]);
  const addSourcesSurface = useCallback(() => {
    if (!activeThreadRef || !activeProject || activeWorkspaceRoot === undefined) return;
    const surface = scientSourcesSurface();
    runAfterPendingFileSave(surface.id, () => {
      useRightPanelStore.getState().openScient(activeThreadRef, surface);
    });
  }, [activeProject, activeThreadRef, activeWorkspaceRoot, runAfterPendingFileSave]);
  const addComputeSurface = useCallback(() => {
    if (!activeThreadRef || activeWorkspaceRoot === undefined) return;
    const surface = scientComputeSurface({
      cwd: activeWorkspaceRoot,
      contextId: createComputeContextId(),
    });
    runAfterPendingFileSave(surface.id, () => {
      useRightPanelStore.getState().openScient(activeThreadRef, surface);
    });
  }, [activeThreadRef, activeWorkspaceRoot, runAfterPendingFileSave]);
  const openScientSourcePdf = useCallback(
    (input: {
      readonly sourceId: string;
      readonly attachmentId: string;
      readonly fileName: string;
    }) => {
      if (!activeThreadRef) return;
      const surface = scientSourcePdfSurface(input);
      runAfterPendingFileSave(surface.id, () => {
        useRightPanelStore.getState().openScient(activeThreadRef, surface);
      });
    },
    [activeThreadRef, runAfterPendingFileSave],
  );
  const openFileSourceSurfaceNow = useCallback(
    (relativePath: string, line?: number, options?: OpenFileOptions) => {
      if (!activeThreadRef || activeWorkspaceRoot === undefined) return;
      const openOptions = {
        ...(shouldOpenInBrowserByDefault(relativePath)
          ? { htmlPreviewMode: "source" as const }
          : {}),
        ...options,
      };
      useRightPanelStore.getState().openFile(activeThreadRef, relativePath, line, openOptions);
    },
    [activeThreadRef, activeWorkspaceRoot],
  );
  const openFileSurfaceNow = useScientFileOpening({
    threadRef: activeThreadRef,
    workspaceRoot: activeWorkspaceRoot ?? null,
    openSource: openFileSourceSurfaceNow,
  });
  const openFileSourceSurface = useCallback(
    (relativePath: string, line?: number, options?: OpenFileOptions) => {
      runAfterPendingFileSave(`file:${relativePath}`, () => {
        openFileSourceSurfaceNow(relativePath, line, options);
      });
    },
    [openFileSourceSurfaceNow, runAfterPendingFileSave],
  );
  return {
    addAgentsSurface,
    addDocumentsSurface,
    addSourcesSurface,
    addComputeSurface,
    openScientSourcePdf,
    openFileSurfaceNow,
    openFileSourceSurface,
  };
}

/** Marks a file surface's HTML or LaTeX presentation request as handled. */
export function useFilePresentationRequestHandlers(activeThreadRef: ScopedThreadRef | null) {
  const handleHtmlPresentationRequestHandled = useCallback(
    (relativePath: string, request: HtmlFilePresentationRequest) => {
      if (!activeThreadRef) return;
      useRightPanelStore
        .getState()
        .consumeHtmlPresentationRequest(activeThreadRef, relativePath, request.id);
    },
    [activeThreadRef],
  );
  const handleLatexPresentationRequestHandled = useCallback(
    (relativePath: string, request: LatexFilePresentationRequest) => {
      if (!activeThreadRef) return;
      useRightPanelStore
        .getState()
        .consumeLatexPresentationRequest(activeThreadRef, relativePath, request.id);
    },
    [activeThreadRef],
  );
  return { handleHtmlPresentationRequestHandled, handleLatexPresentationRequestHandled };
}
