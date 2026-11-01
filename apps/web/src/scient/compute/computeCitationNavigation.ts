import type { ComputeCitation, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  formatComputeCitationHref,
  parseComputeCitationHref,
} from "@t3tools/shared/computeCitations";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { scientComputeSurface } from "~/scient/rightPanel/surfaces";

import { computeFileContextId, useComputeContextStore } from "./computeContextStore";
import { useComputeFilePresentationStore } from "./computeFilePresentationStore";
import { requestComputeQuoteReveal } from "./computeQuoteReveal";

const PREFIX = "compute-citation=";

export function computeCitationHash(citation: ComputeCitation): string {
  return PREFIX + Base64Url.encode(formatComputeCitationHref(citation));
}

export function computeCitationFromLocation(href: string): ComputeCitation | null {
  const index = href.indexOf("#");
  const hash = index < 0 ? "" : href.slice(index + 1);
  // Base64 of the longest link read back, as for file and PDF quotes.
  if (!hash.startsWith(PREFIX) || hash.length > 330_000) return null;
  try {
    return parseComputeCitationHref(
      Result.getOrThrow(Base64Url.decodeString(hash.slice(PREFIX.length))),
    );
  } catch {
    return null;
  }
}

/** The same route activation as file quotes: copied links and repeated clicks reopen the quote. */
export function computeCitationNavigation(citation: ComputeCitation) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: computeCitationHash(citation),
    resetScroll: false,
    state: { fileCitationActivation: randomUUID() },
  };
}

type RunPlace = Extract<ComputeCitation["place"], { readonly _tag: "run" }>;

const isComputeSurface = (surface: RightPanelSurface) =>
  surface.kind === "scient" && surface.module === "compute";

/** The Console tab of this conversation that still holds the run's session. */
function consoleSurfaceFor(ref: ScopedThreadRef, place: RunPlace) {
  const { bindings } = useComputeContextStore.getState();
  const panel = useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)];
  for (const surface of panel?.surfaces ?? []) {
    if (
      isComputeSurface(surface) &&
      surface.contextId !== undefined &&
      bindings[surface.contextId]?.sessionId === place.sessionId
    ) {
      return surface;
    }
  }
  return null;
}

/** The script tab whose Results still hold the run's session; a notebook has no Results feed. */
function scriptContextFor(ref: ScopedThreadRef, cwd: string, place: RunPlace) {
  if (place.path === null || place.path.endsWith(".ipynb")) return null;
  const contextId = computeFileContextId({ ...ref, cwd, relativePath: place.path });
  const binding = useComputeContextStore.getState().bindings[contextId];
  return binding?.sessionId === place.sessionId ? contextId : null;
}

/**
 * Opens the quote where it was taken and asks that surface to show it. A run returns to its script
 * or Console while they still hold its session; Results for the whole project keep every other run.
 */
export function openComputeCitation(
  citation: ComputeCitation,
  currentCwd: string,
  runAfterPendingSave: (surfaceId: string, run: () => void) => void,
): void {
  const ref: ScopedThreadRef = {
    environmentId: citation.environmentId,
    threadId: citation.threadId,
  };
  const { place, cwd } = citation;
  const panel = useRightPanelStore.getState();
  const show = (surfaceId: string, open: () => void) =>
    runAfterPendingSave(surfaceId, () => {
      requestComputeQuoteReveal(citation);
      open();
    });
  if (place._tag === "cell") {
    if (normalizeProjectPathForComparison(currentCwd) === normalizeProjectPathForComparison(cwd)) {
      show(`file:${place.path}`, () => panel.openFile(ref, place.path));
      return;
    }
    const path = `${cwd.replace(/[\\/]+$/, "")}/${place.path}`;
    runAfterPendingSave(`file:${path}`, () => panel.openFile(ref, path));
    toastManager.add({
      type: "info",
      title: "Opening the original workspace file",
      description: "This conversation has moved to another workspace. The quote is unchanged.",
    });
    return;
  }
  const scriptContext = scriptContextFor(ref, cwd, place);
  if (scriptContext !== null && place.path !== null) {
    const { path } = place;
    show(`file:${path}`, () => {
      const presentation = useComputeFilePresentationStore.getState();
      if (presentation.presentations[scriptContext]?.view === "code") {
        presentation.setFileView(scriptContext, "split");
      }
      panel.openFile(ref, path);
    });
    return;
  }
  const consoleSurface = consoleSurfaceFor(ref, place);
  if (consoleSurface !== null) {
    show(consoleSurface.id, () => panel.openScient(ref, consoleSurface));
    return;
  }
  const results = scientComputeSurface({ cwd });
  show(results.id, () => panel.openScient(ref, results));
}
