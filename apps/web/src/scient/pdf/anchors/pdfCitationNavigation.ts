import {
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  PdfSourceDescriptor,
  type PdfDocumentLocator,
  type PdfTarget,
} from "@scientfactory/document-artifacts";
import {
  ChatAttachmentId,
  EnvironmentId,
  type PdfCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison, isWindowsAbsolutePath } from "@t3tools/shared/path";
import { formatPdfCitationHref, parsePdfCitationHref } from "@t3tools/shared/pdfCitations";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";

type GeneratedPdfSourceDescriptor = Extract<PdfSourceDescriptor, { _tag: "generated-pdf" }>;
import { useRightPanelStore } from "~/rightPanelStore";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  scientEnvironmentFileSurface,
  scientGeneratedPdfSurface,
  scientSourcePdfSurface,
} from "~/scient/rightPanel/surfaces";

import { readCurrentGeneratedDocument } from "~/scient/latex/client";

import { environmentPdfSource, workspacePdfRelativePath, workspacePdfSource } from "../pdfSource";
import {
  abandonPdfReveal,
  clearPdfReveals,
  pdfRevealClaimed,
  pdfRevealDocumentKey,
  pendingPdfReveal,
  requestPdfReveal,
} from "./pdfRevealRequests";

const PREFIX = "pdf-citation=";

/**
 * The latest quote navigation. A generated PDF's quote waits for its current
 * revision; any later quote click supersedes it, so a slow answer never opens
 * the earlier PDF over the one asked for since.
 */
let activation = 0;

/** The one panel watcher a waiting quote holds; superseding disposes it. */
let stopWatchingPanel: (() => void) | null = null;

export function supersedePdfCitationNavigation(): void {
  activation += 1;
  stopWatchingPanel?.();
  stopWatchingPanel = null;
  // An earlier quote no longer wanted must not reappear when its PDF opens later.
  clearPdfReveals();
}

export function pdfCitationHash(citation: PdfCitation): string {
  return PREFIX + Base64Url.encode(formatPdfCitationHref(citation));
}

export function pdfCitationFromLocation(href: string): PdfCitation | null {
  const index = href.indexOf("#");
  const hash = index < 0 ? "" : href.slice(index + 1);
  // Base64 of the longest link read back (240,000 characters), as for file quotes.
  if (!hash.startsWith(PREFIX) || hash.length > 330_000) return null;
  try {
    return parsePdfCitationHref(
      Result.getOrThrow(Base64Url.decodeString(hash.slice(PREFIX.length))),
    );
  } catch {
    return null;
  }
}

/** The same route activation as file quotes: copied links and repeated clicks reopen the quote. */
export function pdfCitationNavigation(citation: PdfCitation) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: pdfCitationHash(citation),
    resetScroll: false,
    state: { fileCitationActivation: randomUUID() },
  };
}

type Revealed = { readonly key: string; readonly id: number };

function reveal(
  target: PdfTarget,
  document: { authority: string; logicalDocumentKey: string },
): Revealed {
  const key = pdfRevealDocumentKey(document);
  return { key, id: requestPdfReveal(key, target).id };
}

function unavailable() {
  toastManager.add({
    type: "error",
    title: "Couldn't open the quoted PDF",
    description: "The quote is kept; its PDF can't be opened from here.",
  });
}

/**
 * A path inside a workspace the conversation no longer uses. It opens the way
 * the Files panel will name it: relative to the current workspace when it lies
 * inside it, otherwise by its full path. The reveal is filed under that name.
 */
function openOriginalFile(
  ref: ScopedThreadRef,
  target: PdfTarget,
  original: { readonly workspaceRoot: string; readonly relativePath: string },
  currentCwd: string,
  runAfterPendingSave: (surfaceId: string, run: () => void) => void,
  isCurrent: () => boolean,
  act: (revealed: Revealed, open: () => void) => void,
) {
  const { document } = target;
  const trailing = isWindowsAbsolutePath(original.workspaceRoot) ? /[\\/]+$/ : /\/+$/;
  const path = `${original.workspaceRoot.replace(trailing, "")}/${original.relativePath}`;
  const environmentId = EnvironmentId.make(document.authority);
  const insideCurrent = workspacePdfRelativePath(currentCwd, path);
  const openedPath = insideCurrent ?? path;
  const shown =
    insideCurrent === null
      ? environmentPdfSource({ environmentId, canonicalPath: path, fileName: document.fileName })
      : workspacePdfSource({
          environmentId,
          fileName: document.fileName,
          workspaceRoot: currentCwd,
          relativePath: insideCurrent,
        });
  runAfterPendingSave(`file:${openedPath}`, () => {
    if (!isCurrent()) return;
    const revealed = reveal(target, shown);
    act(revealed, () => useRightPanelStore.getState().openFile(ref, openedPath));
    toastManager.add({
      type: "info",
      title: "Opening the original workspace file",
      description:
        "This conversation has moved to another workspace. The quote opens in the original PDF.",
    });
  });
}

/**
 * A generated PDF opens at its current revision, so a rebuilt document shows
 * the quote in today's PDF (found again by its text when needed). Only when
 * the environment no longer knows the document does the captured revision open.
 */
async function generatedDescriptor(
  citation: PdfCitation,
  locator: Extract<PdfDocumentLocator, { _tag: "generated" }>,
): Promise<GeneratedPdfSourceDescriptor> {
  const { document } = citation.target;
  const current = await readCurrentGeneratedDocument(
    citation.environmentId,
    document.logicalDocumentKey,
  ).catch(() => null);
  if (
    current?.descriptor?._tag === "generated-pdf" &&
    current.descriptor.authority === document.authority
  ) {
    return current.descriptor;
  }
  return PdfSourceDescriptor.make({
    _tag: "generated-pdf",
    authority: document.authority,
    logicalDocumentKey: document.logicalDocumentKey,
    title: document.title,
    fileName: document.fileName,
    capabilities: { canSaveCopy: true, canRevealSource: false },
    artifactId: ArtifactId.make(locator.artifactId),
    revisionId: ArtifactRevisionId.make(locator.revisionId),
    bindingGeneration: BindingGeneration.make(locator.bindingGeneration),
    bindingStatus: "current",
    staleReason: null,
  }) as GeneratedPdfSourceDescriptor;
}

/**
 * Opens the quoted PDF where it was captured and asks its reader to show the
 * quote. Like file quotes, it waits for the active editor's pending save, and
 * a quote from another workspace opens the original file.
 */
export function openPdfCitation(
  citation: PdfCitation,
  currentCwd: string,
  runAfterPendingSave: (surfaceId: string, run: () => void) => void,
): number {
  supersedePdfCitationNavigation();
  const mine = activation;
  const threadKey = scopedThreadKey({
    environmentId: citation.environmentId,
    threadId: citation.threadId,
  });
  const panelOf = (state: ReturnType<typeof useRightPanelStore.getState>) =>
    state.byThreadKey[threadKey];
  // One watcher across the quote's life. Waiting (behind a pending save or a
  // generated PDF's lookup): any change to this thread's panel (another view,
  // closing it) means the user moved on, even if the panel later returns.
  // Opening: the quote's own panel change. Opened: the reveal lives while its
  // PDF stays the active view and until its reader claims it; switching away
  // or closing first abandons it.
  let phase:
    | { readonly _tag: "Waiting" }
    | { readonly _tag: "Opening" }
    | ({ readonly _tag: "Opened"; readonly surface: string | null } & Revealed) = {
    _tag: "Waiting",
  };
  let interrupted = false;
  const unsubscribe = useRightPanelStore.subscribe((state, previous) => {
    const now = panelOf(state);
    const before = panelOf(previous);
    // The quote's own opening is not the user moving on.
    if (phase._tag === "Opening") return;
    if (phase._tag === "Waiting") {
      if (now?.activeSurfaceId !== before?.activeSurfaceId || now?.isOpen !== before?.isOpen) {
        interrupted = true;
        stopWatching();
      }
      return;
    }
    if (!pendingPdfReveal(phase.key) || pdfRevealClaimed(phase.key, phase.id)) {
      stopWatching();
    } else if (now?.activeSurfaceId !== phase.surface || now?.isOpen === false) {
      abandonPdfReveal(phase.key, phase.id);
      stopWatching();
    }
  });
  const stopWatching = () => {
    unsubscribe();
    if (stopWatchingPanel === stopWatching) stopWatchingPanel = null;
  };
  stopWatchingPanel = stopWatching;
  const stillWanted = () => mine === activation && !interrupted;
  const act = (revealed: Revealed, open: () => void) => {
    phase = { _tag: "Opening" };
    open();
    phase = {
      _tag: "Opened",
      ...revealed,
      surface: panelOf(useRightPanelStore.getState())?.activeSurfaceId ?? null,
    };
  };
  try {
    openPdfCitationNow(citation, currentCwd, runAfterPendingSave, stillWanted, act);
  } catch {
    // A link that parsed but names something the panel can't open.
    stopWatching();
    unavailable();
  }
  return mine;
}

/** The latest quote navigation; a cleanup may only cancel the one it started. */
export function pdfCitationActivation(): number {
  return activation;
}

function openPdfCitationNow(
  citation: PdfCitation,
  currentCwd: string,
  runAfterPendingSave: (surfaceId: string, run: () => void) => void,
  isCurrent: () => boolean,
  act: (revealed: Revealed, open: () => void) => void,
): void {
  const { target } = citation;
  const { document } = target;
  const ref: ScopedThreadRef = {
    environmentId: citation.environmentId,
    threadId: citation.threadId,
  };
  const sameWorkspace = (root: string) =>
    normalizeProjectPathForComparison(currentCwd) === normalizeProjectPathForComparison(root);
  const locator = document.locator;
  switch (locator._tag) {
    case "workspace":
      if (!sameWorkspace(locator.workspaceRoot)) {
        openOriginalFile(ref, target, locator, currentCwd, runAfterPendingSave, isCurrent, act);
        return;
      }
      runAfterPendingSave(`file:${locator.relativePath}`, () => {
        if (!isCurrent()) return;
        const revealed = reveal(target, document);
        act(revealed, () => useRightPanelStore.getState().openFile(ref, locator.relativePath));
      });
      return;
    case "source": {
      // The Sources panel reads the active workspace's library; another
      // workspace's paper opens as the original file instead.
      if (!sameWorkspace(locator.workspaceRoot)) {
        openOriginalFile(ref, target, locator, currentCwd, runAfterPendingSave, isCurrent, act);
        return;
      }
      const surface = scientSourcePdfSurface({
        sourceId: locator.sourceId,
        attachmentId: locator.attachmentId,
        fileName: document.fileName,
      });
      runAfterPendingSave(surface.id, () => {
        if (!isCurrent()) return;
        const revealed = reveal(target, document);
        act(revealed, () => useRightPanelStore.getState().openScient(ref, surface));
      });
      return;
    }
    case "generated":
      void generatedDescriptor(citation, locator).then(
        (source) => {
          if (!isCurrent()) return;
          const surface = scientGeneratedPdfSurface(source);
          runAfterPendingSave(surface.id, () => {
            if (!isCurrent()) return;
            const revealed = reveal(target, source);
            act(revealed, () => useRightPanelStore.getState().openScient(ref, surface));
          });
        },
        () => {
          if (isCurrent()) unavailable();
        },
      );
      return;
    case "attachment": {
      const attachment = {
        type: "file" as const,
        id: ChatAttachmentId.make(locator.attachmentId),
        name: document.title,
        mimeType: "application/pdf",
        sizeBytes: locator.sizeBytes ?? 1,
      };
      runAfterPendingSave(`attachment:${attachment.id}`, () => {
        if (!isCurrent()) return;
        const revealed = reveal(target, document);
        act(revealed, () => useRightPanelStore.getState().openAttachment(ref, attachment));
      });
      return;
    }
    case "environment": {
      const surface = scientEnvironmentFileSurface({ path: locator.path });
      runAfterPendingSave(surface.id, () => {
        if (!isCurrent()) return;
        const revealed = reveal(target, document);
        act(revealed, () => useRightPanelStore.getState().openScient(ref, surface));
      });
      return;
    }
  }
}
