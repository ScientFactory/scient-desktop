import { useCallback } from "react";
import { FileCitation, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { SelectionCitationToolbar } from "~/components/chat/AssistantSelectionToolbar";
import { toastManager } from "~/components/ui/toast";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import type { MarkdownCiteHandler } from "../markdownEditor/markdownCitation";
import { retainLatexSelection } from "./latexSelectionSession";
import { latexCitationRevision, type LatexVisualSelectionSnapshot } from "./latexVisualSelection";

const acceptsSelection = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest("math-field,[data-table-selection],textarea,.ProseMirror") !== null;

export function LatexCitationActions({
  viewport,
  source,
  capture,
  onCite,
  ownerId,
}: {
  viewport: HTMLElement | null;
  source: ScopedThreadRef & { cwd: string };
  capture: () => LatexVisualSelectionSnapshot | null;
  onCite: MarkdownCiteHandler;
  ownerId: string;
}) {
  const { environmentId, threadId, cwd } = source;
  const captureCitation = useCallback(() => {
    const selection = capture();
    const content = selection?.content;
    if (
      !viewport ||
      !selection ||
      !content?.text.trim() ||
      !(content.selected ?? content.from !== content.to)
    )
      return null;
    const owner = selection.sourceOwner;
    let prefix = owner.source.slice(Math.max(0, owner.from - 32), owner.from);
    let suffix = owner.source.slice(owner.to, owner.to + 32);
    // Keep the bounded contexts intact when a boundary falls inside a surrogate pair.
    if (/^[\uDC00-\uDFFF]/u.test(prefix)) prefix = prefix.slice(1);
    if (/[\uD800-\uDBFF]$/u.test(suffix)) suffix = suffix.slice(0, -1);
    const citation = {
      kind: "file" as const,
      version: 1 as const,
      environmentId,
      threadId,
      cwd,
      path: owner.path,
      revision: selection.revision,
      origin: owner.source === owner.baselineSource ? ("saved" as const) : ("draft" as const),
      sourceStart: owner.from,
      sourceEnd: owner.to,
      startLine: owner.source.slice(0, owner.from).split("\n").length,
      endLine: owner.source.slice(0, Math.max(owner.from, owner.to - 1)).split("\n").length,
      // LaTeX citations quote a model fragment; these are quote offsets, not MathLive offsets.
      from: 0,
      to: content.text.length,
      text: content.text,
      prefix,
      suffix,
      latex: {
        rootRelativePath: owner.rootRelativePath,
        sourceHash: latexCitationRevision(owner.source.slice(owner.from, owner.to)),
      },
    };
    if (!Schema.is(FileCitation)(citation)) return null;
    const range = selection.element.ownerDocument.createRange();
    range.selectNodeContents(selection.element);
    const anchor: AssistantCitationSourceAnchor = {
      source: selection.element,
      viewport,
      range,
      selectionOwnerId: ownerId,
      resolveRects: () => (selection.isCurrent() ? selection.geometry() : []),
      retainSelection: () => retainLatexSelection(viewport),
    };
    return { citation, sourceAnchor: anchor };
  }, [capture, viewport, environmentId, threadId, cwd, ownerId]);
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!viewport) return () => {};
      viewport.addEventListener("scient-latex-selection-scope", changed);
      return () => viewport.removeEventListener("scient-latex-selection-scope", changed);
    },
    [viewport],
  );
  return (
    <SelectionCitationToolbar
      viewport={viewport}
      capture={captureCitation}
      subscribeSelection={subscribe}
      allowPreventedSelectionStart={acceptsSelection}
      selectionOwnerId={ownerId}
      preserveSelection
      onCite={(citation, anchor) => {
        const current = capture();
        if (
          !current ||
          !current.isCurrent() ||
          current.revision !== citation.revision ||
          current.sourceOwner.path !== citation.path ||
          current.content?.text !== citation.text ||
          current.sourceOwner.from !== citation.sourceStart ||
          current.sourceOwner.to !== citation.sourceEnd
        ) {
          toastManager.add({
            type: "warning",
            title: "The selection has changed",
            description: "Select the content again to cite its current version.",
          });
          return false;
        }
        const accepted = onCite(citation, anchor);
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
