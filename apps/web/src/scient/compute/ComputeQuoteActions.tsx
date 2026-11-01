import { EditorView } from "@codemirror/view";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  type ComputeCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { SelectionCitationToolbar } from "~/components/chat/AssistantSelectionToolbar";
import { toastManager } from "~/components/ui/toast";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useStableCallback } from "~/hooks/useStableCallback";
import {
  captureAssistantTextSelection,
  createAssistantTextSelector,
  type AssistantCitationSourceAnchor,
  type AssistantTextSelector,
} from "~/lib/assistantTextSelection";

export type ComputePlace = ComputeCitation["place"];

interface ComputeQuoteScope {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
}

const isCodeEditorTarget = (target: EventTarget | null) =>
  target instanceof Element && target.closest(".cm-editor") !== null;

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** A run's place, written on it by `computeRunAttributes`. */
export function computeRunPlace(source: HTMLElement): ComputePlace | null {
  const { assistantCitationSource: executionId, computeSession, computePath } = source.dataset;
  return executionId === undefined || computeSession === undefined
    ? null
    : {
        _tag: "run",
        sessionId: computeSession,
        executionId,
        path: computePath ?? null,
      };
}

/** Marks a run as something selected text can be quoted from. */
export function computeRunAttributes(run: {
  readonly sessionId: string;
  readonly executionId: string;
  readonly path: string | null;
}) {
  return {
    "data-assistant-citation-source": run.executionId,
    "data-compute-session": run.sessionId,
    ...(run.path === null ? {} : { "data-compute-path": run.path }),
  };
}

/** Text selected in an editor, which the rendered-text capture leaves out. */
function captureEditorSelection(viewport: HTMLElement, selection: Selection | null) {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const editor = elementOf(range.startContainer)?.closest<HTMLElement>("[contenteditable]") ?? null;
  if (editor === null || editor !== elementOf(range.endContainer)?.closest("[contenteditable]")) {
    return null;
  }
  const source = editor.closest<HTMLElement>("[data-assistant-citation-source]");
  if (source === null || !viewport.contains(source)) return null;
  // A code editor keeps only the lines in view on the page, so it reads its own selection, in the
  // whole document so that a repeated word is found again where it was selected.
  const code = EditorView.findFromDOM(editor);
  const text = selection.toString();
  const selector =
    code === null
      ? createAssistantTextSelector(text, 0, text.length)
      : createAssistantTextSelector(
          code.state.doc.toString(),
          code.state.selection.main.from,
          code.state.selection.main.to,
        );
  return selector === null ? null : { source, selector, range: range.cloneRange() };
}

function quoteAnchor(
  source: HTMLElement,
  viewport: HTMLElement,
  range: Range,
): AssistantCitationSourceAnchor {
  return {
    source,
    range,
    viewport,
    // Output arriving elsewhere is not this quote changing.
    resolveRange: () =>
      range.startContainer.isConnected && range.endContainer.isConnected && !range.collapsed
        ? range
        : null,
  };
}

function computeCitation(
  scope: ComputeQuoteScope,
  place: ComputePlace,
  selector: AssistantTextSelector,
): ComputeCitation {
  return {
    kind: "compute",
    version: 1,
    environmentId: scope.threadRef.environmentId,
    threadId: scope.threadRef.threadId,
    cwd: scope.cwd,
    place,
    text: selector.text,
    start: selector.start,
    end: selector.end,
    prefix: selector.prefix,
    suffix: selector.suffix,
  };
}

/** Ask in chat about a whole run or cell: its code stands for it, and the agent reads the rest. */
export function useAskAboutCompute(scope: ComputeQuoteScope) {
  const composerRef = useComposerHandleContext();
  if (composerRef === null) return null;
  return (input: {
    readonly source: HTMLElement;
    readonly place: ComputePlace;
    readonly text: string;
  }) => {
    const { source, place } = input;
    const viewport = source.closest<HTMLElement>("[data-assistant-citation-viewport]");
    const text = input.text.trim().slice(0, ASSISTANT_CITATION_MAX_TEXT_LENGTH);
    const selector = createAssistantTextSelector(text, 0, text.length);
    if (viewport === null || selector === null) return;
    const range = source.ownerDocument.createRange();
    range.selectNodeContents(source);
    composerRef.current?.citeText(
      computeCitation(scope, place, selector),
      quoteAnchor(source, viewport, range),
    );
  };
}

/** The "Ask in chat" every document shows, for text selected in runs or notebook cells. */
export function ComputeQuoteActions(
  props: ComputeQuoteScope & {
    readonly viewport: HTMLElement | null;
    readonly placeOf: (source: HTMLElement) => ComputePlace | null;
  },
) {
  const composerRef = useComposerHandleContext();
  const { viewport, placeOf } = props;
  // Stable, so output arriving mid-drag does not restart the selection watcher.
  const capture = useStableCallback(() => {
    if (viewport === null) return null;
    const selection = window.getSelection();
    const captured =
      captureAssistantTextSelection(viewport, selection) ??
      captureEditorSelection(viewport, selection);
    const place = captured === null ? null : placeOf(captured.source);
    if (captured === null || place === null) return null;
    return {
      citation: computeCitation(props, place, captured.selector),
      sourceAnchor: quoteAnchor(captured.source, viewport, captured.range),
    };
  });
  if (composerRef === null) return null;
  return (
    <SelectionCitationToolbar
      viewport={viewport}
      capture={capture}
      allowPreventedSelectionStart={isCodeEditorTarget}
      onCite={(citation, anchor) => {
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
