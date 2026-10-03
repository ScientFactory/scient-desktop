import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Extension, Node, type Editor, type Extensions } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";
import { LatexDraftContext, restoredLatexFieldDraft } from "./LatexTextField";
import { latexTableInlineContent, serializeLatexVisualBlock } from "./latexVisualDocument";
import {
  activateLatexEditingTarget,
  clearLatexEditingTarget,
  LatexInlineOwnerContext,
} from "./latexEditingTarget";

const inlineDocument = (source: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: latexTableInlineContent(source) ?? [] }],
});

/** Inline content in source-owned objects shares the document's math views and history. */
export function LatexInlineField(props: {
  owner: Editor;
  source: string;
  label: string;
  cell: string;
  width: string;
  style?: CSSProperties | undefined;
  disabled: boolean;
  draftKey?: string | undefined;
  extensions: Extensions;
  onFocus: () => void;
  onChange: (source: string) => boolean;
  onTab: (direction: -1 | 1) => void;
  onExit: (direction: -1 | 1) => void;
}) {
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const { reportDraft } = useContext(LatexDraftContext);
  const id = useId();
  const [initialSource] = useState(() => restoredLatexFieldDraft(props.draftKey, props.source));
  const pending = useRef<string | null>(initialSource === props.source ? null : initialSource);
  const acknowledged = useRef(props.source);
  const root = useRef<HTMLDivElement>(null);
  const editor = useEditor({
    shouldRerenderOnTransaction: false,
    extensions: [
      StarterKit.configure({
        document: false,
        undoRedo: false,
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        horizontalRule: false,
        hardBreak: false,
        link: false,
        strike: false,
        code: false,
        trailingNode: false,
      }),
      Node.create({ name: "doc", topNode: true, content: "paragraph" }),
      ...props.extensions,
      Extension.create({
        name: "objectDocumentHistory",
        addCommands: () => ({
          undo: () => () => current.current.owner.commands.undo(),
          redo: () => () => current.current.owner.commands.redo(),
        }),
      }),
    ],
    content: inlineDocument(initialSource),
    editable: !props.disabled,
    enableInputRules: false,
    enablePasteRules: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": props.label,
        "data-table-cell": props.cell,
        class: "scient-latex-inline-field-content",
      },
      handleKeyDown: (view, event) => {
        if (event.isComposing) return false;
        const command = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (command && (key === "z" || key === "y")) {
          event.preventDefault();
          return key === "y" || event.shiftKey
            ? current.current.owner.commands.redo()
            : current.current.owner.commands.undo();
        }
        if (event.key === "Tab") {
          event.preventDefault();
          current.current.onTab(event.shiftKey ? -1 : 1);
          return true;
        }
        if (event.key === "Escape") {
          current.current.onExit(1);
          return true;
        }
        // A tabular cell is one inline flow; Enter cannot create another table row accidentally.
        if (event.key === "Enter") {
          current.current.onTab(1);
          return true;
        }
        if (!command && !event.shiftKey && view.state.selection.empty) {
          const { $from } = view.state.selection;
          if (event.key === "ArrowLeft" && $from.parentOffset === 0) {
            current.current.onTab(-1);
            return true;
          }
          if (event.key === "ArrowRight" && $from.parentOffset === $from.parent.content.size) {
            current.current.onTab(1);
            return true;
          }
        }
        return false;
      },
    },
    onFocus: ({ editor: field }) => {
      activateLatexEditingTarget(current.current.owner, field);
      current.current.onFocus();
    },
    onBlur: ({ editor: field, event }) => {
      const next = event.relatedTarget;
      if (
        next instanceof Element &&
        next.closest(".scient-latex-visual-document") &&
        !root.current?.contains(next)
      )
        clearLatexEditingTarget(current.current.owner, field);
    },
    onUpdate: ({ editor: field }) => {
      const paragraph = field.getJSON().content?.[0];
      const source = paragraph?.content?.length ? serializeLatexVisualBlock(paragraph) : "";
      if (source === null || source === undefined) return;
      const accepted = current.current.onChange(source);
      pending.current = accepted ? null : source;
      if (accepted) acknowledged.current = source;
      reportDraft(id, !accepted);
      const key = current.current.draftKey;
      if (key) {
        try {
          if (accepted) localStorage.removeItem(`scient.latex.field:${key}`);
          else
            localStorage.setItem(
              `scient.latex.field:${key}`,
              JSON.stringify({ base: acknowledged.current, text: source }),
            );
        } catch {
          /* Optional recovery storage. */
        }
      }
    },
  });
  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(!props.disabled, false);
    editor.view.dom.setAttribute("aria-label", props.label);
    editor.view.dom.setAttribute("data-table-cell", props.cell);
    if (props.source !== acknowledged.current && pending.current === null) {
      let cancelled = false;
      // React node views must update after the enclosing document's commit.
      queueMicrotask(() => {
        if (cancelled || editor.isDestroyed || pending.current !== null) return;
        const position = editor.state.selection.from;
        editor.commands.setContent(inlineDocument(props.source), { emitUpdate: false });
        editor.view.dispatch(
          editor.state.tr.setSelection(
            TextSelection.near(
              editor.state.doc.resolve(Math.min(position, editor.state.doc.content.size)),
            ),
          ),
        );
        acknowledged.current = props.source;
      });
      return () => {
        cancelled = true;
      };
    }
  }, [editor, props.source, props.disabled, props.label, props.cell]);
  useEffect(() => {
    if (!editor) return;
    reportDraft(id, pending.current !== null);
    const clear = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".scient-latex-visual-document") &&
        !root.current?.contains(event.target)
      )
        clearLatexEditingTarget(props.owner, editor);
    };
    document.addEventListener("pointerdown", clear, true);
    return () => {
      document.removeEventListener("pointerdown", clear, true);
      clearLatexEditingTarget(props.owner, editor);
      reportDraft(id, false);
    };
  }, [editor, props.owner, id, reportDraft]);
  return (
    <div
      ref={root}
      className="scient-latex-inline-field"
      data-table-cell-width={props.width}
      data-empty={!latexTableInlineContent(props.source)?.length || undefined}
      style={props.style}
      onFocusCapture={() => {
        if (editor) activateLatexEditingTarget(props.owner, editor);
      }}
    >
      <LatexInlineOwnerContext value={props.owner}>
        <EditorContent editor={editor} />
      </LatexInlineOwnerContext>
    </div>
  );
}
