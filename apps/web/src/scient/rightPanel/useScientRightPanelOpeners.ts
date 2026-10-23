import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { ScopedThreadRef } from "@t3tools/contracts";

import {
  type HtmlFilePresentationRequest,
  type LatexFilePresentationRequest,
  type OpenFileOptions,
  useRightPanelStore,
} from "~/rightPanelStore";
import { createComputeContextId } from "~/scient/compute/computeContextStore";
import type { NewDocumentFormat } from "~/scient/documents/documentTemplates";
import { useCreateNewDocument } from "~/scient/documents/useCreateNewDocument";
import { shouldOpenInBrowserByDefault } from "~/scient/fileOpening/fileOpeningPolicy";
import { useScientFileOpening } from "~/scient/fileOpening/useScientFileOpening";
import type { useActivePendingSurfaceDeparture } from "~/scient/fileSurfaces/usePendingSurfaceDeparture";

import {
  scientComputeSurface,
  scientNewTabSurface,
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
  const addAgentsSurface = () => {
    if (!activeThreadRef) return;
    runAfterPendingFileSave("agents", () => {
      useRightPanelStore.getState().open(activeThreadRef, "agents");
    });
  };
  const addSourcesSurface = () => {
    if (!activeThreadRef || !activeProject || activeWorkspaceRoot === undefined) return;
    const surface = scientSourcesSurface();
    runAfterPendingFileSave(surface.id, () => {
      useRightPanelStore.getState().openScient(activeThreadRef, surface);
    });
  };
  // `whenEmpty` reads the panel as it is now, so a repeated call adds one tab.
  const addNewTabSurface = (options?: { readonly whenEmpty?: boolean }) => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    const surfaces = store.byThreadKey[scopedThreadKey(activeThreadRef)]?.surfaces ?? [];
    if (options?.whenEmpty && surfaces.length > 0) return;
    const surface = scientNewTabSurface();
    runAfterPendingFileSave(surface.id, () => {
      useRightPanelStore.getState().openScient(activeThreadRef, surface);
    });
  };
  const addComputeSurface = () => {
    if (!activeThreadRef || activeWorkspaceRoot === undefined) return;
    const surface = scientComputeSurface({
      cwd: activeWorkspaceRoot,
      contextId: createComputeContextId(),
    });
    runAfterPendingFileSave(surface.id, () => {
      useRightPanelStore.getState().openScient(activeThreadRef, surface);
    });
  };
  const openScientSourcePdf = (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => {
    if (!activeThreadRef) return;
    const surface = scientSourcePdfSurface(input);
    runAfterPendingFileSave(surface.id, () => {
      useRightPanelStore.getState().openScient(activeThreadRef, surface);
    });
  };
  const openFileSourceSurfaceNow = (
    relativePath: string,
    line?: number,
    options?: OpenFileOptions,
  ) => {
    if (!activeThreadRef || activeWorkspaceRoot === undefined) return;
    const openOptions = {
      ...(shouldOpenInBrowserByDefault(relativePath) ? { htmlPreviewMode: "source" as const } : {}),
      ...options,
    };
    useRightPanelStore.getState().openFile(activeThreadRef, relativePath, line, openOptions);
  };
  const openFileSurfaceNow = useScientFileOpening({
    threadRef: activeThreadRef,
    workspaceRoot: activeWorkspaceRoot ?? null,
    openSource: openFileSourceSurfaceNow,
  });
  const openFileSourceSurface = (
    relativePath: string,
    line?: number,
    options?: OpenFileOptions,
  ) => {
    runAfterPendingFileSave(`file:${relativePath}`, () => {
      openFileSourceSurfaceNow(relativePath, line, options);
    });
  };
  // A document started by hand opens in its editor at the project's top folder.
  const createNewDocument = useCreateNewDocument();
  const addDocumentsSurface = (format: NewDocumentFormat) => {
    if (!activeThreadRef || activeWorkspaceRoot === undefined) return;
    createNewDocument({
      format,
      environmentId: activeThreadRef.environmentId,
      cwd: activeWorkspaceRoot,
      base: "",
      open: (relativePath) =>
        openFileSourceSurface(relativePath, undefined, { latexPreviewMode: "visual" }),
    });
  };
  return {
    addNewTabSurface,
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
  const handleHtmlPresentationRequestHandled = useStableCallback(
    (relativePath: string, request: HtmlFilePresentationRequest) => {
      if (!activeThreadRef) return;
      useRightPanelStore
        .getState()
        .consumeHtmlPresentationRequest(activeThreadRef, relativePath, request.id);
    },
  );
  const handleLatexPresentationRequestHandled = useStableCallback(
    (relativePath: string, request: LatexFilePresentationRequest) => {
      if (!activeThreadRef) return;
      useRightPanelStore
        .getState()
        .consumeLatexPresentationRequest(activeThreadRef, relativePath, request.id);
    },
  );
  return { handleHtmlPresentationRequestHandled, handleLatexPresentationRequestHandled };
}
