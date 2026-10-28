import { isPdfCitation, type FileCitation, type ScopedThreadRef } from "@t3tools/contracts";
import { formatFileCitationHref, parseFileCitationHref } from "@t3tools/shared/composerCitations";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { useEffect, useRef } from "react";
import { useRightPanelStore } from "~/rightPanelStore";
import { randomUUID } from "~/lib/utils";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { toastManager } from "~/components/ui/toast";
import {
  openPdfCitation,
  pdfCitationActivation,
  pdfCitationFromLocation,
  supersedePdfCitationNavigation,
} from "~/scient/pdf/anchors/pdfCitationNavigation";

declare module "@tanstack/react-router" {
  interface HistoryState {
    fileCitationActivation?: string;
  }
}

const PREFIX = "file-citation=";
export function fileCitationHash(citation: FileCitation): string {
  return PREFIX + Base64Url.encode(formatFileCitationHref(citation));
}

export function fileCitationFromLocation(href: string): FileCitation | null {
  const index = href.indexOf("#");
  const hash = index < 0 ? "" : href.slice(index + 1);
  if (!hash.startsWith(PREFIX) || hash.length > 330_000) return null;
  try {
    return parseFileCitationHref(
      Result.getOrThrow(Base64Url.decodeString(hash.slice(PREFIX.length))),
    );
  } catch {
    return null;
  }
}

export function fileCitationNavigation(citation: FileCitation) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: fileCitationHash(citation),
    resetScroll: false,
    state: { fileCitationActivation: randomUUID() },
  };
}

/** Use the captured workspace, never resolve the basename in whichever project is active. */
export function openFileCitation(
  citation: FileCitation,
  currentCwd: string,
  runAfterPendingSave: (surfaceId: string, run: () => void) => void,
): void {
  const sameWorkspace =
    normalizeProjectPathForComparison(currentCwd) ===
    normalizeProjectPathForComparison(citation.cwd);
  // This is a literal file path, not a Markdown/terminal link with # or :line syntax.
  const root = citation.cwd.replace(isWindowsAbsolutePath(citation.cwd) ? /[\\/]+$/ : /\/+$/, "");
  const path =
    sameWorkspace || citation.path.startsWith("/") || isWindowsAbsolutePath(citation.path)
      ? citation.path
      : `${root}/${citation.path}`;
  runAfterPendingSave(`file:${path}`, () => {
    useRightPanelStore.getState().openFile(
      { environmentId: citation.environmentId, threadId: citation.threadId },
      path,
      citation.latex || citation.sourceSelection ? citation.startLine : undefined,
      sameWorkspace
        ? {
            fileCitation: citation,
            ...(citation.sourceSelection
              ? { latexPreviewMode: "source" as const, htmlPreviewMode: "source" as const }
              : {}),
            ...(citation.latex
              ? {
                  latexRootRelativePath: citation.latex.rootRelativePath,
                  latexPreviewMode: citation.sourceSelection
                    ? ("source" as const)
                    : ("split" as const),
                }
              : {}),
          }
        : undefined,
    );
    if (!sameWorkspace)
      toastManager.add({
        type: "info",
        title: "Opening the original workspace file",
        description:
          "This conversation has moved to another workspace. The original file opens read-only; the saved quote is unchanged.",
      });
  });
}

/** Reuse route activation: copied links and repeated clicks also open the exact source. */
export function useFileCitationTarget(
  ref: ScopedThreadRef | null,
  location: { href: string; key: string | undefined },
  currentCwd: string | undefined,
  runAfterPendingSave: (surfaceId: string, run: () => void) => void,
): void {
  const citation =
    fileCitationFromLocation(location.href) ?? pdfCitationFromLocation(location.href);
  const handled = useRef<string | null>(null);
  // Leaving the thread abandons the PDF quote this view started, if it is
  // still the latest. The cleanup waits a task: React's development replay
  // re-runs this effect for the same thread at once, which is not leaving it.
  // A view replaced by another never cancels the newer view's quote.
  const threadKey = ref ? `${ref.environmentId}\0${ref.threadId}` : null;
  const started = useRef<number | null>(null);
  const leaving = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons this hook's PDF citation activation on a deferred timer when the thread changes or it unmounts
  useEffect(() => {
    const abandonOwn = () => {
      if (started.current !== null && started.current === pdfCitationActivation()) {
        supersedePdfCitationNavigation();
      }
      started.current = null;
    };
    const pending = leaving.current;
    if (pending) {
      clearTimeout(pending.timer);
      leaving.current = null;
      if (pending.key !== threadKey) abandonOwn();
    }
    if (threadKey === null) return;
    return () => {
      leaving.current = {
        key: threadKey,
        timer: setTimeout(() => {
          leaving.current = null;
          abandonOwn();
        }, 0),
      };
    };
  }, [threadKey]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the cited PDF or file through the citation navigation registry when the router location changes
  useEffect(() => {
    if (
      !citation ||
      !ref ||
      currentCwd === undefined ||
      citation.environmentId !== ref.environmentId ||
      citation.threadId !== ref.threadId
    )
      return;
    const key = `${location.key ?? ""}:${location.href}`;
    if (handled.current === key) return;
    handled.current = key;
    if (isPdfCitation(citation)) {
      started.current = openPdfCitation(citation, currentCwd, runAfterPendingSave);
    } else {
      // A later file quote supersedes a PDF quote still waiting for its document.
      supersedePdfCitationNavigation();
      openFileCitation(citation, currentCwd, runAfterPendingSave);
    }
  }, [citation, ref, location.href, location.key, currentCwd, runAfterPendingSave]);
}
