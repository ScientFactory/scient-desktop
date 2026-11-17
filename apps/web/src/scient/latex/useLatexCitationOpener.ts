import type { CitationItem } from "@scientfactory/scient-sources";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useRef, type MouseEvent, type PointerEvent } from "react";

import { sourceOffset } from "../math/input/sourceAdapter";
import { openCitation } from "../sources/citationNavigation";
import { resolveCitationEntries } from "../sources/citationNavigationModel";
import { useLibraryVersionStore } from "../sources/librarySourceRequest";
import { useLibraryCitations } from "../sources/useLibraryCitations";
import {
  isCitationOpenClick,
  latexSourceCitationAt,
  type LatexSourceCitation,
} from "./latexCitationOpen";

export interface LatexCitationOpener {
  /** Whether a click on these items would open a Library source, so it should not edit. */
  readonly opens: (items: ReadonlyArray<CitationItem>) => boolean;
  readonly open: (
    items: ReadonlyArray<CitationItem>,
    quote: string | null,
    at: { readonly x: number; readonly y: number },
  ) => void;
}

/**
 * Opens the Library sources a citation names, in the conversation the document belongs to.
 * Null while the Library is read, and for a document with no conversation yet.
 */
export function useLatexCitationOpener(input: {
  readonly environmentId: EnvironmentId | null;
  readonly root: string | null;
  readonly threadRef: ScopedThreadRef | undefined;
  /** The open document, project-relative: its bibliography decides what a key names. */
  readonly documentPath: string | null;
}): LatexCitationOpener | null {
  const root = input.root ?? "";
  const threadRef = input.threadRef;
  const documentPath = input.documentPath;
  const environmentId = root && threadRef ? input.environmentId : null;
  const version = useLibraryVersionStore((state) => state.byRoot[root] ?? "");
  const candidates = useLibraryCitations({ environmentId, root, refresh: version });
  if (environmentId === null || !threadRef || candidates === null) return null;
  return {
    opens: (items) => resolveCitationEntries(candidates, items).length > 0,
    open: (items, quote, at) => {
      openCitation({ environmentId, threadRef, root, documentPath, candidates, items, quote, at });
    },
  };
}

/** The line and character of the source text under a pointer in the file editor's shadow DOM. */
function sourceCaretAtPointer(event: globalThis.MouseEvent) {
  let token: HTMLElement | null = null;
  for (const candidate of event.composedPath()) {
    if (!(candidate instanceof HTMLElement)) continue;
    if (candidate.closest("[data-line-annotation]")) return null;
    token ??= candidate.dataset.char === undefined ? null : candidate;
    if (candidate.dataset.line === undefined) continue;
    const line = Number(candidate.dataset.line);
    const base = Number(token?.dataset.char);
    if (!token || !Number.isSafeInteger(line) || !Number.isSafeInteger(base)) return null;
    // The boundary nearest the pointer among the token's glyphs.
    const walker = token.ownerDocument.createTreeWalker(token, NodeFilter.SHOW_TEXT);
    const range = token.ownerDocument.createRange();
    let offset = 0;
    let nearest = 0;
    let distance = Infinity;
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const length = text.textContent?.length ?? 0;
      for (let index = 0; index < length; index++) {
        range.setStart(text, index);
        range.setEnd(text, index + 1);
        for (const rect of range.getClientRects()) {
          const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
          for (const [edge, boundary] of [
            [rect.left, index],
            [rect.right, index + 1],
          ] as const) {
            const next = (edge - event.clientX) ** 2 + dy ** 2;
            if (next < distance) {
              distance = next;
              nearest = offset + boundary;
            }
          }
        }
      }
      offset += length;
    }
    return { line: line - 1, character: base + nearest };
  }
  return null;
}

/**
 * Command-click (Control-click) on a citation in the LaTeX source opens its source instead of
 * adding a caret. The press is taken from the editor; the click opens.
 */
export function useLatexSourceCitationOpen(
  opener: LatexCitationOpener | null,
  source: () => string | null | undefined,
) {
  const pending = useRef<LatexSourceCitation | null>(null);
  const take = (event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      pending.current = null;
      const text = source();
      if (!opener || text == null || !isCitationOpenClick(event)) return;
      const caret = sourceCaretAtPointer(event.nativeEvent);
      const citation = caret && latexSourceCitationAt(text, sourceOffset(text, caret));
      if (!citation || !opener.opens(citation.items)) return;
      pending.current = citation;
      take(event);
    },
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      if (pending.current) take(event);
    },
    onClick: (event: MouseEvent<HTMLElement>) => {
      const citation = pending.current;
      pending.current = null;
      if (!citation || !opener) return;
      take(event);
      opener.open(citation.items, citation.quote, { x: event.clientX, y: event.clientY });
    },
  };
}
