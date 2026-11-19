import type { OfficeCitation, ScopedThreadRef } from "@t3tools/contracts";
import {
  formatOfficeCitationHref,
  officeCitationPlaceLabel,
  parseOfficeCitationHref,
} from "@t3tools/shared/officeCitations";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import { createContext, use, useId, useSyncExternalStore, type ReactElement } from "react";

import { SelectionCitationToolbar } from "~/components/chat/AssistantSelectionToolbar";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useStableCallback } from "~/hooks/useStableCallback";
import { captureAssistantTextSelection } from "~/lib/assistantTextSelection";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { SideChatCitationContext } from "../chat/sideChatCitation";

/** The workspace file an Office reader shows, and the conversation its quotes go to. */
export interface OfficeFile {
  readonly citeThread: ScopedThreadRef;
  readonly cwd: string;
  /** Relative to `cwd`. */
  readonly path: string;
}

/** Given by the file panel; without it a reader offers no Ask in chat. */
export const OfficeFileContext = createContext<OfficeFile | null>(null);

const absolute = (cwd: string, path: string) =>
  path.startsWith("/") || isWindowsAbsolutePath(path)
    ? path
    : `${cwd.replace(isWindowsAbsolutePath(cwd) ? /[\\/]+$/ : /\/+$/, "")}/${path}`;
const samePath = (left: string, right: string) =>
  normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);

/** A quote waiting for its file's reader to show it: the page, and the text to mark there. */
export type OfficeReveal = { readonly file: string; readonly page: number; readonly text: string };

let reveal: OfficeReveal | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function setReveal(next: OfficeReveal | null) {
  reveal = next;
  for (const listener of listeners) listener();
}

/** The quote waiting for this file's reader, if any; the reader takes it once shown. */
export function useOfficeReveal(file: OfficeFile | null) {
  const pending = useSyncExternalStore(subscribe, () => reveal);
  return pending && file && samePath(pending.file, absolute(file.cwd, file.path)) ? pending : null;
}

export function takeOfficeReveal(taken: OfficeReveal) {
  if (reveal === taken) setReveal(null);
}

const PREFIX = "office-citation=";

export function officeCitationHash(citation: OfficeCitation): string {
  return PREFIX + Base64Url.encode(formatOfficeCitationHref(citation));
}

export function officeCitationFromLocation(href: string): OfficeCitation | null {
  const index = href.indexOf("#");
  const hash = index < 0 ? "" : href.slice(index + 1);
  // Base64 of the longest link read back, as for file and PDF quotes.
  if (!hash.startsWith(PREFIX) || hash.length > 330_000) return null;
  try {
    return parseOfficeCitationHref(
      Result.getOrThrow(Base64Url.decodeString(hash.slice(PREFIX.length))),
    );
  } catch {
    return null;
  }
}

/** The same route activation as file quotes: copied links and repeated clicks reopen the quote. */
export function officeCitationNavigation(citation: OfficeCitation) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: officeCitationHash(citation),
    resetScroll: false,
    state: { fileCitationActivation: randomUUID() },
  };
}

/** Opens the quoted file at its page, with the quote marked; the captured workspace, as file quotes. */
export function openOfficeCitation(
  citation: OfficeCitation,
  currentCwd: string,
  runAfterPendingSave: (surfaceId: string, run: () => void) => void,
): void {
  const file = absolute(citation.cwd, citation.path);
  const path = samePath(currentCwd, citation.cwd) ? citation.path : file;
  runAfterPendingSave(`file:${path}`, () => {
    // The quote's first line marks where it starts, however the reader breaks its lines.
    const text = citation.text.trim().split("\n", 1)[0]!.trim().slice(0, 120);
    setReveal({ file, page: citation.page, text });
    useRightPanelStore
      .getState()
      .openFile({ environmentId: citation.environmentId, threadId: citation.threadId }, path);
  });
}

/** Compact hover card for an Office quote: where it came from and the excerpt. */
export function OfficeCitationHoverCard(props: {
  readonly citation: OfficeCitation;
  readonly trigger: ReactElement;
}) {
  const popupId = useId();
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} aria-describedby={popupId} />
      <TooltipPopup side="top" className="max-w-72" role="tooltip" id={popupId}>
        <span className="flex min-w-0 flex-col gap-0.5 py-0.5 text-left">
          <span className="font-medium text-foreground">
            {officeCitationPlaceLabel(props.citation)}
          </span>
          <span className="mt-0.5 line-clamp-2 border-l-2 border-border pl-1.5 text-2xs text-muted-foreground">
            {props.citation.text.replace(/\s+/g, " ").trim()}
          </span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Marks a page's text layer as quotable: Ask in chat finds the page from it. */
export function officeQuoteSource(index: number) {
  return { "data-assistant-citation-source": "", "data-office-page": index + 1 };
}

/** The "Ask in chat" every document shows, for text selected on a page or slide. */
export function OfficeQuoteActions(props: {
  readonly viewport: HTMLElement | null;
  readonly unit: OfficeCitation["unit"];
}) {
  const file = use(OfficeFileContext);
  const composerRef = useComposerHandleContext();
  const citeInSideChat = use(SideChatCitationContext);
  const { viewport, unit } = props;
  const capture = useStableCallback(() => {
    if (viewport === null || file === null) return null;
    const captured = captureAssistantTextSelection(viewport, window.getSelection());
    const page = Number(captured?.source.dataset.officePage);
    if (!captured || !Number.isSafeInteger(page) || page < 1) return null;
    const { source, range, selector } = captured;
    const citation: OfficeCitation = {
      kind: "office",
      version: 1,
      environmentId: file.citeThread.environmentId,
      threadId: file.citeThread.threadId,
      cwd: file.cwd,
      path: file.path,
      unit,
      page,
      text: selector.text,
      prefix: selector.prefix,
      suffix: selector.suffix,
    };
    return {
      citation,
      sourceAnchor: {
        source,
        range,
        viewport,
        // Pages drawing elsewhere are not this quote changing.
        resolveRange: () =>
          range.startContainer.isConnected && range.endContainer.isConnected && !range.collapsed
            ? range
            : null,
      },
    };
  });
  if (composerRef === null || file === null) return null;
  return (
    <SelectionCitationToolbar
      viewport={viewport}
      capture={capture}
      onCite={(citation, anchor, destination) => {
        if (destination === "side-chat" && citeInSideChat) {
          citeInSideChat(citation);
          return true;
        }
        const accepted = composerRef.current?.citeText(citation, anchor) ?? false;
        if (!accepted)
          toastManager.add({
            type: "warning",
            title: "Could not add the citation",
            description: "The chat input is not ready. Your selection is unchanged.",
          });
        return accepted;
      }}
    />
  );
}
