import { useLayoutEffect } from "react";
import type { Editor } from "@pierre/diffs/edit";
import type { FileCitation } from "@t3tools/contracts";
import { useEffect, useRef, useId } from "react";
import { SelectionCitationToolbar } from "~/components/chat/AssistantSelectionToolbar";
import { toastManager } from "~/components/ui/toast";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { CitationDestination } from "../chat/sideChatCitation";
import type { MarkdownCiteHandler } from "../markdownEditor/markdownCitation";
import { sourcePosition } from "../math/input/sourceAdapter";
import {
  createSourceCitation,
  resolveSourceCitation,
  sourceCitationRects,
  staticSourceSelection,
  type SourceCitationTarget,
} from "./sourceCitation";
import { SourceCaretAction } from "./SourceCaretAction";

const allowSourceSelection = () => true;

/** The text a caret on this one-based line stands for when asking in chat. */
export type SourceCaretQuote = (
  source: string,
  line: number,
) => { readonly from: number; readonly to: number } | null;

export function SourceCitationActions<Annotation>({
  editor,
  viewport,
  target,
  baseline,
  ready,
  onCite,
  reveal,
  revealId,
  staticSource,
  caretQuote,
}: {
  editor: Editor<"file", Annotation, undefined> | null;
  viewport: HTMLElement | null;
  target: SourceCitationTarget;
  baseline: () => string;
  ready: () => boolean;
  onCite?: MarkdownCiteHandler | undefined;
  reveal?: FileCitation | undefined;
  revealId: number;
  staticSource?: string | undefined;
  caretQuote?: SourceCaretQuote | undefined;
}) {
  const { environmentId, threadId, cwd, path, latexRootRelativePath } = target;
  const ownerId = useId();
  const currentStaticSource = useRef(staticSource);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps a ref mirroring the static source for imperative citation handlers to read
  useLayoutEffect(() => {
    currentStaticSource.current = staticSource;
  });
  const currentSelection = () => {
    const state = editor?.getEditState();
    const selections = editor?.getViewState().selections;
    if (
      !viewport ||
      editor?.isComposing ||
      !ready() ||
      (editor && (!state || selections?.length !== 1))
    )
      return null;
    let focused = viewport.ownerDocument.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    if (focused?.closest("input,textarea,select,[data-line-annotation]")) return null;
    if (
      editor &&
      !focused?.closest("[data-content][contenteditable=true]") &&
      focused?.closest<HTMLElement>("[data-writing-menu-owner]")?.dataset.writingMenuOwner !==
        ownerId
    )
      return null;
    const source = editor?.getFile() ? editor.getText() : staticSource;
    if (source === undefined) return null;
    const selected =
      state && selections?.length === 1
        ? {
            from: state.document.offsetAt(selections[0]!.start),
            to: state.document.offsetAt(selections[0]!.end),
          }
        : staticSourceSelection(viewport, source);
    return selected ? { source, ...selected } : null;
  };
  const quote = (source: string, from: number, to: number) => {
    if (!viewport) return null;
    const citation = createSourceCitation(
      { environmentId, threadId, cwd, path, latexRootRelativePath },
      source,
      baseline(),
      from,
      to,
    );
    if (!citation || !sourceCitationRects(viewport, source, from, to).length) return null;
    const range = viewport.ownerDocument.createRange();
    range.selectNodeContents(viewport);
    return {
      citation,
      sourceAnchor: {
        source: viewport,
        viewport,
        range,
        selectionOwnerId: ownerId,
        resolveRects: () =>
          (
            editor
              ? editor.getFile() && editor.getText() === source
              : currentStaticSource.current === source
          )
            ? sourceCitationRects(viewport, source, from, to)
            : [],
      },
    };
  };
  const capture = () => {
    const selected = currentSelection();
    return selected && quote(selected.source, selected.from, selected.to);
  };
  const captureCaret = useStableCallback(() => {
    const selected = currentSelection();
    if (!selected || selected.from !== selected.to) return null;
    const { source, from } = selected;
    const range = caretQuote?.(source, sourcePosition(source, from).line + 1);
    return range ? quote(source, range.from, range.to) : null;
  });
  const handled = useRef<{ editor: typeof editor; id: number } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves the editor selection or posts a warning toast when a citation reveal request arrives
  useEffect(() => {
    if (!reveal?.sourceSelection || !ready()) return;
    const source = editor?.getFile() ? editor.getText() : staticSource;
    if (source === undefined || !viewport) return;
    if (handled.current?.editor === editor && handled.current.id === revealId) return;
    handled.current = { editor, id: revealId };
    const match = resolveSourceCitation(source, reveal);
    if (match && editor)
      editor.setSelections([
        {
          start: sourcePosition(editor.getText(), match.from),
          end: sourcePosition(editor.getText(), match.to),
          direction: "forward",
        },
      ]);
    else if (!match)
      toastManager.add({
        type: "warning",
        title: "The quoted source has changed",
        description: "Showing its recorded line. Its exact location could not be verified.",
      });
  }, [editor, reveal, revealId, ready, staticSource, viewport]);
  if (!onCite) return null;
  const cite = (
    citation: FileCitation,
    anchor: AssistantCitationSourceAnchor,
    destination: CitationDestination,
  ) => {
    // Activating the action can move focus or collapse the native selection.
    // Validate the captured offsets against the source, not that live selection.
    const source = editor ? editor.getFile()?.contents : currentStaticSource.current;
    const current =
      source !== undefined && ready() && !editor?.isComposing
        ? createSourceCitation(
            { environmentId, threadId, cwd, path, latexRootRelativePath },
            source,
            baseline(),
            citation.sourceStart,
            citation.sourceEnd,
          )
        : null;
    if (
      !current ||
      current.revision !== citation.revision ||
      current.text !== citation.text ||
      current.environmentId !== citation.environmentId ||
      current.threadId !== citation.threadId ||
      current.cwd !== citation.cwd ||
      current.path !== citation.path ||
      current.latex?.rootRelativePath !== citation.latex?.rootRelativePath ||
      anchor.source !== viewport ||
      !anchor.source.isConnected ||
      anchor.selectionOwnerId !== ownerId ||
      !anchor.resolveRects?.().length
    ) {
      toastManager.add({
        type: "warning",
        title: "The selection has changed",
        description: "Select the source again to cite its current version.",
      });
      return false;
    }
    const accepted = onCite(current, anchor, destination);
    if (!accepted)
      toastManager.add({
        type: "warning",
        title: "Could not add the citation",
        description: "The chat input is not ready. Your selection is unchanged.",
      });
    return accepted;
  };
  return (
    <>
      <SelectionCitationToolbar
        viewport={viewport}
        capture={capture}
        preserveSelection
        selectionOwnerId={ownerId}
        allowPreventedSelectionStart={allowSourceSelection}
        onCite={cite}
      />
      {caretQuote ? (
        <SourceCaretAction viewport={viewport} capture={captureCaret} onCite={cite} />
      ) : null}
    </>
  );
}
