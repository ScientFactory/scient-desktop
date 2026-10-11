import {
  activateLatexContext,
  isLatexEditingMenuEvent,
  latexContextRoot,
} from "./latexContextEvents";
import {
  useEffect,
  useCallback,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { preserveLatexCaret } from "./latexObjectCaret";
import { LatexTextField } from "./LatexTextField";

type Props = Pick<NodeViewProps, "node" | "editor" | "updateAttributes" | "selected" | "getPos"> & {
  editable: boolean;
  draftKey: string | null;
};

export function LatexTitleView({
  node,
  editor,
  updateAttributes,
  selected,
  editable,
  getPos,
  draftKey,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const [active, setActive] = useState(false);
  const [addingAuthor, setAddingAuthor] = useState(false);
  const [addingDate, setAddingDate] = useState(false);
  const authorEnabled = node.attrs.authorEnabled === true;
  const showAuthor = authorEnabled || addingAuthor;
  const dateMode =
    node.attrs.dateMode === "hidden"
      ? "hidden"
      : node.attrs.dateMode === "explicit"
        ? "explicit"
        : "automatic";
  const sourceMeta = node.attrs.sourceMeta as {
    titleEditable?: boolean;
    authorEditable?: boolean;
    dateEditable?: boolean;
  } | null;
  const focusField = useCallback(
    (field: "title" | "author" | "date") =>
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLTextAreaElement>(`[aria-label="Document ${field}"]`)
          ?.focus({ preventScroll: true }),
      ),
    [],
  );
  const exit = (direction: -1 | 1) => {
    const position = getPos();
    if (typeof position !== "number") return;
    const boundary = direction < 0 ? position : position + node.nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(boundary), direction)),
    );
    editor.commands.focus(undefined, { scrollIntoView: false });
    setActive(false);
  };
  const removeEmptyTitle = () => {
    if (!editable || !editor.isEditable || editor.isDestroyed) return;
    const position = getPos();
    if (typeof position !== "number") return;
    const current = editor.state.doc.nodeAt(position);
    if (
      !current ||
      current.type !== node.type ||
      current.attrs.kind !== "title" ||
      current.attrs.sourceMeta?.titleEditable === false
    )
      return;
    // Settle a just-cleared field before removing its block, so Undo restores
    // the empty title even when the typing publication has not run yet.
    if (current.attrs.title !== "") updateAttributes({ title: "" });
    const cleared = editor.state.doc.nodeAt(position);
    if (!cleared || cleared.attrs.title !== "") return;
    const transaction = closeHistory(editor.state.tr).delete(position, position + cleared.nodeSize);
    const boundary = Math.min(position, transaction.doc.content.size);
    const caret =
      Selection.findFrom(transaction.doc.resolve(boundary), 1, true) ??
      Selection.findFrom(transaction.doc.resolve(boundary), -1, true);
    if (caret) transaction.setSelection(caret);
    else {
      transaction.insert(boundary, editor.schema.nodes.paragraph!.create());
      transaction.setSelection(TextSelection.create(transaction.doc, boundary + 1));
    }
    editor.view.dispatch(transaction.scrollIntoView());
    if (!editor.state.doc.eq(transaction.doc)) return;
    editor.view.dispatch(closeHistory(editor.state.tr));
    editor.view.focus();
    setActive(false);
  };
  const activate = () => {
    if (!editable) return;
    activateLatexContext(editor.view.dom, id);
    setActive(true);
  };
  const activation = useRef(activate);
  activation.current = activate;
  useEffect(() => {
    if (selected) activation.current();
  }, [selected]);
  useEffect(() => {
    const deactivate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setActive(false);
    };
    const scope = latexContextRoot(editor.view.dom);
    scope.addEventListener("scient-latex-context-activate", deactivate);
    return () => scope.removeEventListener("scient-latex-context-activate", deactivate);
  }, [editor, id]);
  useEffect(() => {
    if (!active) return;
    const outside = (event: PointerEvent) => {
      if (isLatexEditingMenuEvent(event, editor.view.dom)) return;
      const path = event.composedPath();
      if (!path.includes(root.current!)) setActive(false);
    };
    const focusOutside = (event: globalThis.FocusEvent) => {
      if (isLatexEditingMenuEvent(event, editor.view.dom)) return;
      const path = event.composedPath();
      if (!path.includes(root.current!)) setActive(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", focusOutside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", focusOutside);
    };
  }, [active, editor]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const edit = (event: Event) => {
      const field = (event as CustomEvent<"title" | "author" | "date">).detail;
      if (field === "author") setAddingAuthor(true);
      if (field === "date") setAddingDate(true);
      activation.current();
      focusField(field);
    };
    element.addEventListener("scient-latex-edit-title", edit);
    return () => element.removeEventListener("scient-latex-edit-title", edit);
  }, [focusField]);
  return (
    <NodeViewWrapper
      ref={root}
      data-latex-context-root={id}
      className="scient-latex-title-preview"
      contentEditable={false}
      data-active={active || undefined}
      onFocusCapture={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.target)) return;
        activate();
        if (event.target instanceof HTMLTextAreaElement) {
          preserveLatexCaret(editor.view);
        }
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (!(event.target instanceof HTMLTextAreaElement) || event.nativeEvent.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) editor.commands.redo();
          else editor.commands.undo();
        } else if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          event.stopPropagation();
          event.target.blur();
          exit(1);
        } else if (event.key === "Tab") {
          const fields = [
            ...(root.current?.querySelectorAll<HTMLTextAreaElement>("textarea:not(:disabled)") ??
              []),
          ];
          const index = fields.indexOf(event.target) + (event.shiftKey ? -1 : 1);
          event.preventDefault();
          if (fields[index]) fields[index].focus({ preventScroll: true });
          else exit(event.shiftKey ? -1 : 1);
        }
      }}
      onPointerDown={activate}
    >
      <LatexTextField
        aria-label="Document title"
        placeholder="Title"
        rows={1}
        disabled={!editable || sourceMeta?.titleEditable === false}
        draftKey={draftKey ? `${draftKey}:title` : undefined}
        value={String(node.attrs.title ?? "")}
        onValueChange={(title) => updateAttributes({ title })}
        onRemoveEmpty={removeEmptyTitle}
      />
      {showAuthor ? (
        <LatexTextField
          aria-label="Document author"
          rows={1}
          disabled={!editable || sourceMeta?.authorEditable === false}
          draftKey={draftKey ? `${draftKey}:author` : undefined}
          value={String(node.attrs.author ?? "")}
          onValueChange={(author) => {
            setAddingAuthor(!author.trim());
            updateAttributes({ author, authorEnabled: Boolean(author.trim()) });
          }}
        />
      ) : null}
      {dateMode !== "hidden" || addingDate ? (
        <LatexTextField
          aria-label="Document date"
          rows={1}
          disabled={!editable || sourceMeta?.dateEditable === false}
          draftKey={draftKey ? `${draftKey}:date` : undefined}
          value={String(node.attrs.date ?? "")}
          onValueChange={(date) => {
            if (date.trim()) updateAttributes({ date, dateEnabled: true, dateMode: "explicit" });
          }}
          onBlur={(event) => {
            if (!event.currentTarget.value.trim()) {
              updateAttributes({ date: "", dateEnabled: false, dateMode: "hidden" });
              setAddingDate(false);
            }
          }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}
