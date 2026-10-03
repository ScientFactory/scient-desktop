import { Extension, type Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import {
  clearScientMarkdownSearch,
  configureScientMarkdownSearch,
  navigateScientMarkdownSearch,
  scientMarkdownSearchPlugin,
  scientMarkdownSearchState,
} from "../markdownEditor/prosemirror/search";
import type { ScientFindBarController, ScientFindBarState } from "../writing/ScientFindBar";
import { afterEditorPaint } from "./afterEditorPaint";

/** Reuse document-text search without sending search transactions through the save lane. */
export const LatexVisualSearch = Extension.create({
  name: "latexVisualSearch",
  addProseMirrorPlugins: () => [scientMarkdownSearchPlugin()],
});

/**
 * Replaces the matches one text block at a time, last block first so earlier
 * positions stay valid. `commit` writes a block to the source; the next block
 * waits for a paint, because the source owner takes one edit per update.
 *
 * The positions were found in one document. The work therefore stops as soon
 * as the document is anything other than what the previous replacement left:
 * typing, undo, or a newer file from disk all end it. It also stops at the
 * first block the source refuses, and while text is being composed.
 * Returns a function that stops the remaining work.
 */
function replaceByBlock(
  editor: Editor,
  targets: readonly { readonly from: number; readonly to: number }[],
  replacement: string,
  commit: () => boolean,
): () => void {
  let cancel = () => {};
  // Pending typing goes to the source first, so each block below is one change.
  if (editor.view.composing || !commit()) return cancel;
  const blocks = new Map<number, { readonly from: number; readonly to: number }[]>();
  for (const { from, to } of targets) {
    const block = editor.state.doc.resolve(from).start();
    blocks.set(block, [...(blocks.get(block) ?? []), { from, to }]);
  }
  const order = [...blocks.keys()].sort((a, b) => b - a);
  let expected = editor.state.doc;
  const replaceBlock = (index: number) => {
    cancel = () => {};
    const matches = blocks.get(order[index]!);
    if (!matches || editor.isDestroyed || !editor.isEditable || editor.view.composing) return;
    if (editor.state.doc !== expected) return;
    let transaction = editor.state.tr;
    for (const match of matches.toReversed())
      transaction = transaction.insertText(replacement, match.from, match.to);
    editor.view.dispatch(index === 0 ? transaction.scrollIntoView() : transaction);
    // The editor refuses an edit its source cannot hold.
    if (editor.state.doc === expected || !commit()) return;
    expected = editor.state.doc;
    if (index + 1 < order.length) cancel = afterEditorPaint(() => replaceBlock(index + 1));
  };
  replaceBlock(0);
  return () => cancel();
}

/**
 * `editable` turns on Replace. A replacement is an ordinary text edit in the
 * editor, so it is written to the LaTeX source the same way typing is.
 *
 * The source is updated one text block at a time, as it is for typing. Replace
 * all therefore edits one block, has `commit` write it to the source, and
 * moves to the next after a paint; it stops at the first block the source
 * refuses. Each block is its own undo step for the same reason.
 */
export function useLatexVisualSearch(
  editor: Editor | null,
  editable = false,
  commit: () => boolean = () => true,
) {
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
  // Replace all runs over several paints; closing the bar or starting again stops it.
  const stopReplacing = useRef(() => {});
  useEffect(() => () => stopReplacing.current(), []);
  const search = useEditorState({
    editor,
    selector: ({ editor }) => (editor ? scientMarkdownSearchState(editor.state) : null),
  });
  const revealMatch = () => {
    editor?.view.dom
      .querySelector<HTMLElement>('[data-scient-markdown-search-match="active"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const close = () => {
    stopReplacing.current();
    setOpen(false);
    if (editor)
      editor.view.dispatch(
        clearScientMarkdownSearch(editor.state.tr).setMeta("addToHistory", false),
      );
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected) target.focus();
    else editor?.commands.focus(undefined, { scrollIntoView: false });
  };
  const show = () => {
    if (!open)
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    setFocusRequest((value) => value + 1);
  };
  const controller: ScientFindBarController = {
    view: editor?.view ?? null,
    configureFind: (input) => {
      if (!editor) return;
      editor.view.dispatch(
        configureScientMarkdownSearch(editor.state.tr, input).setMeta("addToHistory", false),
      );
      revealMatch();
    },
    navigateFind: (direction) => {
      if (!editor) return;
      editor.view.dispatch(
        navigateScientMarkdownSearch(editor.state.tr, direction).setMeta("addToHistory", false),
      );
      revealMatch();
    },
    replaceFind: (replacement, all) => {
      if (!editor || !editable) return false;
      const search = scientMarkdownSearchState(editor.state);
      const targets = all ? search.matches : search.matches.slice(search.activeIndex).slice(0, 1);
      if (targets.length === 0) return false;
      stopReplacing.current();
      stopReplacing.current = replaceByBlock(editor, targets, replacement, commit);
      return true;
    },
    closeFind: close,
    setFindOpen: (value) => (value ? show() : close()),
  };
  const snapshot: ScientFindBarState = {
    editable,
    findActiveIndex: search?.activeIndex ?? 0,
    findCaseSensitive: search?.caseSensitive ?? false,
    findFocusRequest: focusRequest,
    findMatchCount: search?.matches.length ?? 0,
    findOpen: open,
    findQuery: search?.query ?? "",
    findWholeWord: search?.wholeWord ?? false,
  };
  return { controller, snapshot, open, show, close };
}
