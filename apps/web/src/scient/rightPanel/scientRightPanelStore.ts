import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { FileCitation, ScopedThreadRef } from "@t3tools/contracts";

import {
  previewStaticImageDescriptorKey,
  type PreviewStaticImageSurfaceDescriptor,
} from "~/previewStaticImageSurface";
import type { RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";

import { scientArtifactSurface, type ScientRightPanelSurface } from "./surfaces";

export interface LatexFilePresentationRequest {
  readonly id: number;
  readonly mode: "split";
}

export interface HtmlFilePresentationRequest {
  readonly id: number;
  readonly mode: "source";
}

export interface OpenFileOptions {
  readonly fileCitation?: FileCitation;
  readonly htmlPreviewMode?: HtmlFilePresentationRequest["mode"];
  readonly latexPreviewMode?: LatexFilePresentationRequest["mode"];
  /** Root retained when SyncTeX navigates from a multi-file PDF to a source. */
  readonly latexRootRelativePath?: string;
}

/**
 * A file surface's one-shot requests: the cited text to reveal and the
 * presentation (HTML source, LaTeX split) the opener asked for, keyed to the
 * reveal they came with, and the LaTeX root kept across source navigation.
 */
export function scientFileSurfaceRequests(revealRequestId: number, options?: OpenFileOptions) {
  return {
    ...(options?.fileCitation ? { fileCitation: options.fileCitation } : {}),
    ...(options?.htmlPreviewMode === undefined
      ? {}
      : {
          htmlPresentationRequest: {
            id: revealRequestId,
            mode: options.htmlPreviewMode,
          },
        }),
    ...(options?.latexPreviewMode === undefined
      ? {}
      : {
          latexPresentationRequest: {
            id: revealRequestId,
            mode: options.latexPreviewMode,
          },
        }),
    ...(typeof options?.latexRootRelativePath === "string"
      ? { latexRootRelativePath: options.latexRootRelativePath }
      : {}),
  };
}

/** A persisted LaTeX root, kept only when it is still a safe relative path. */
export function scientPersistedLatexRootRelativePath(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes("\0") &&
    !/^(?:[\\/]|[A-Za-z]:)/u.test(value) &&
    !value.split(/[\\/]/u).includes("..")
    ? value
    : undefined;
}

/** Persisted file surfaces drop their one-shot requests and citation reveal. */
export function withoutTransientFileRequests(surface: RightPanelSurface): RightPanelSurface {
  if (surface.kind !== "file") return surface;
  const {
    htmlPresentationRequest: _transientHtmlPresentationRequest,
    latexPresentationRequest: _transientLatexPresentationRequest,
    fileCitation: _transientFileCitation,
    ...persistentSurface
  } = surface;
  return persistentSurface;
}

type ThreadUpdater = (current: ThreadRightPanelState) => ThreadRightPanelState;

/**
 * The right-panel actions Scient adds: Scient-owned surfaces and artifacts,
 * and consuming a file surface's presentation requests once applied. They use
 * the store's own update helpers, so user choices and automatic updates are
 * counted exactly as for the inherited actions.
 */
export function scientRightPanelActions<State>(
  set: (update: (state: State) => Partial<State>) => void,
  {
    updateThread,
    upsertSurface,
    userAction,
  }: {
    readonly updateThread: (
      state: State,
      threadKey: string,
      updater: ThreadUpdater,
    ) => Partial<State>;
    readonly upsertSurface: (
      current: ThreadRightPanelState,
      surface: RightPanelSurface,
    ) => ThreadRightPanelState;
    readonly userAction: (
      state: State,
      threadKey: string,
      updater: ThreadUpdater,
    ) => Partial<State>;
  },
) {
  return {
    openScient: (ref: ScopedThreadRef, surface: ScientRightPanelSurface) =>
      set((state) =>
        userAction(state, scopedThreadKey(ref), (current) => {
          const next = upsertSurface(current, surface);
          if (!current.surfaces.some((entry) => entry.id === surface.id)) return next;
          return {
            ...next,
            surfaces: current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry)),
          };
        }),
      ),
    updateScientGeneratedPdf: (
      ref: ScopedThreadRef,
      surface: Extract<ScientRightPanelSurface, { readonly module: "generated-pdf" }>,
    ) =>
      set((state) => ({
        ...updateThread(state, scopedThreadKey(ref), (current) => {
          if (!current.surfaces.some((entry) => entry.id === surface.id)) return current;
          return {
            ...current,
            surfaces: current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry)),
          };
        }),
      })),
    openScientArtifact: (ref: ScopedThreadRef, artifact: PreviewStaticImageSurfaceDescriptor) =>
      set((state) =>
        userAction(state, scopedThreadKey(ref), (current) => {
          const surface = scientArtifactSurface(artifact);
          const existing = current.surfaces.some((entry) => entry.id === surface.id);
          return {
            isOpen: true,
            activeSurfaceId: surface.id,
            surfaces: existing
              ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
              : [...current.surfaces, surface],
          };
        }),
      ),
    updateScientArtifact: (ref: ScopedThreadRef, artifact: PreviewStaticImageSurfaceDescriptor) =>
      set((state) => ({
        ...updateThread(state, scopedThreadKey(ref), (current) => {
          const surface = scientArtifactSurface(artifact);
          const existing = current.surfaces.find((entry) => entry.id === surface.id);
          if (!existing || existing.kind !== "scient" || existing.module !== "artifact") {
            return current;
          }
          if (
            previewStaticImageDescriptorKey(existing.artifact) ===
            previewStaticImageDescriptorKey(artifact)
          ) {
            return current;
          }
          return {
            ...current,
            surfaces: current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry)),
          };
        }),
      })),
    consumeLatexPresentationRequest: (
      ref: ScopedThreadRef,
      relativePath: string,
      requestId: number,
    ) =>
      set((state) => ({
        ...updateThread(state, scopedThreadKey(ref), (current) => {
          let changed = false;
          const surfaces = current.surfaces.map((surface): RightPanelSurface => {
            if (
              surface.kind !== "file" ||
              surface.relativePath !== relativePath ||
              surface.latexPresentationRequest?.id !== requestId
            ) {
              return surface;
            }
            changed = true;
            const {
              latexPresentationRequest: _consumedLatexPresentationRequest,
              ...remainingSurface
            } = surface;
            return remainingSurface;
          });
          return changed ? { ...current, surfaces } : current;
        }),
      })),
    consumeHtmlPresentationRequest: (
      ref: ScopedThreadRef,
      relativePath: string,
      requestId: number,
    ) =>
      set((state) => ({
        ...updateThread(state, scopedThreadKey(ref), (current) => {
          let changed = false;
          const surfaces = current.surfaces.map((surface): RightPanelSurface => {
            if (
              surface.kind !== "file" ||
              surface.relativePath !== relativePath ||
              surface.htmlPresentationRequest?.id !== requestId
            ) {
              return surface;
            }
            changed = true;
            const {
              htmlPresentationRequest: _consumedHtmlPresentationRequest,
              ...remainingSurface
            } = surface;
            return remainingSurface;
          });
          return changed ? { ...current, surfaces } : current;
        }),
      })),
  };
}
