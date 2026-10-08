import type { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  type ContextType,
  type ReactNode,
} from "react";
import { projectLatexVisualDocument, serializeLatexVisualBlock } from "./latexVisualDocument";

export const LatexAuthoringContext = createContext<{
  source: string;
  /** Only declaration changes invalidate objects that render from the preamble. */
  preamble?: string;
  prepare: () => boolean;
  reportError?: (message: string | null) => void;
  renameLabel?: (before: string, after: string, fieldId?: string) => boolean;
}>({
  source: "",
  prepare: () => true,
});

const LatexActionNoticeContext = createContext<((message: string | null) => void) | null>(null);

/** Source readers update independently of the stable notice callback. */
export function LatexDocumentAuthoring({
  value,
  children,
}: {
  value: ContextType<typeof LatexAuthoringContext>;
  children: ReactNode;
}) {
  return createElement(
    LatexActionNoticeContext,
    { value: value.reportError ?? null },
    createElement(LatexAuthoringContext, { value }, children),
  );
}

/** Object menus report action failures through the document's notice area. */
export function useLatexActionNotice() {
  const reportError = useContext(LatexActionNoticeContext);
  return useCallback((message: string | null) => reportError?.(message || null), [reportError]);
}

/** One editor transaction, with fresh source ownership and the existing preservation gate. */
export function editLatexObjectSource(
  editor: Editor,
  position: number | undefined,
  setup: string,
  transform: (source: string) => { source: string } | { error: string },
): string | null {
  if (!editor.isEditable || position === undefined) return "This object is read-only.";
  const current = editor.state.doc.nodeAt(position);
  const source = current && serializeLatexVisualBlock(current.toJSON());
  if (!current || source == null) return "Finish the current edit before changing this object.";
  const result = transform(source);
  if ("error" in result) return result.error;
  if (source === result.source) return null;
  const projection = projectLatexVisualDocument(result.source, 0, setup);
  const nodes = projection.content.content ?? [];
  if (nodes.length !== 1 || nodes[0]?.type === "latexRawBlock")
    return "This change is outside the supported visual structure. Your source was kept.";
  const json = nodes[0]!;
  json.attrs = { ...json.attrs, sourceId: current.attrs.sourceId };
  const replacement = editor.schema.nodeFromJSON(json);
  const tr = editor.state.tr.replaceWith(position, position + current.nodeSize, replacement);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(position + 1, tr.doc.content.size))));
  editor.view.dispatch(tr);
  const accepted = editor.state.doc.nodeAt(position);
  return accepted?.eq(replacement)
    ? null
    : "This change could not be applied. Finish pending edits and try again.";
}
