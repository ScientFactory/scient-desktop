import { Extension, type Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useRef, useState } from "react";
import {
  clearScientMarkdownSearch,
  configureScientMarkdownSearch,
  navigateScientMarkdownSearch,
  scientMarkdownSearchPlugin,
  scientMarkdownSearchState,
} from "../markdownEditor/prosemirror/search";
import type { ScientFindBarController, ScientFindBarState } from "../writing/ScientFindBar";

/** Reuse document-text search without sending search transactions through the save lane. */
export const LatexVisualSearch = Extension.create({
  name: "latexVisualSearch",
  addProseMirrorPlugins: () => [scientMarkdownSearchPlugin()],
});

/**
 * `editable` turns on Replace. A replacement is an ordinary text edit in the
 * editor, so it is written to the LaTeX source the same way typing is.
 */
export function useLatexVisualSearch(editor: Editor | null, editable = false) {
  const [open, setOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const returnFocus = useRef<HTMLElement | null>(null);
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
      let transaction = editor.state.tr;
      // Last match first, so earlier positions stay valid.
      for (let index = targets.length - 1; index >= 0; index -= 1) {
        const match = targets[index]!;
        transaction = transaction.insertText(replacement, match.from, match.to);
      }
      editor.view.dispatch(transaction.scrollIntoView());
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
