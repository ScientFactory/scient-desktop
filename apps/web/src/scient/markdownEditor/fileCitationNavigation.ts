import type { FileCitation, ScopedThreadRef } from "@t3tools/contracts";
import { formatFileCitationHref, parseFileCitationHref } from "@t3tools/shared/composerCitations";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import { useEffect, useMemo, useRef } from "react";
import { useRightPanelStore } from "~/rightPanelStore";
import { randomUUID } from "~/lib/utils";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { toastManager } from "~/components/ui/toast";

declare module "@tanstack/react-router" {
  interface HistoryState {
    fileCitationActivation?: string;
  }
}

const PREFIX = "file-citation=";
export function fileCitationHash(citation: FileCitation): string {
  return PREFIX + Encoding.encodeBase64Url(formatFileCitationHref(citation));
}

export function fileCitationFromLocation(href: string): FileCitation | null {
  const index = href.indexOf("#");
  const hash = index < 0 ? "" : href.slice(index + 1);
  if (!hash.startsWith(PREFIX) || hash.length > 330_000) return null;
  try {
    return parseFileCitationHref(
      Result.getOrThrow(Encoding.decodeBase64UrlString(hash.slice(PREFIX.length))),
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
    useRightPanelStore
      .getState()
      .openFile(
        { environmentId: citation.environmentId, threadId: citation.threadId },
        path,
        undefined,
        sameWorkspace ? { fileCitation: citation } : undefined,
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
  const citation = useMemo(() => fileCitationFromLocation(location.href), [location.href]);
  const handled = useRef<string | null>(null);
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
    openFileCitation(citation, currentCwd, runAfterPendingSave);
  }, [citation, ref, location.href, location.key, currentCwd, runAfterPendingSave]);
}
