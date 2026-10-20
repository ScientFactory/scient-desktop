import {
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Extension, Node, type Editor, type Extensions } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Plugin, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { useStableCallback } from "~/hooks/useStableCallback";
import { LatexDraftContext, restoredLatexFieldDraft } from "./LatexTextField";
import {
  latexTableInlineContent,
  serializeLatexVisualBlock,
  latexVisualNodeSignature,
} from "./latexVisualDocument";
import { LatexWritingKeys } from "./latexWritingKeys";
import { LatexProseCompletion } from "./latexProseCompletion";
import { LatexCommandContext } from "./LatexCompletionContext";
import { createEditorBackgroundTask } from "./editorBackgroundTask";
import { afterEditorPaint } from "./afterEditorPaint";
import { createLatexFieldJournal } from "./latexFieldJournal";
import { isSourceOwnedTyping } from "./visualTyping";
import { LatexStructuredSelection } from "./latexStructuredSelection";
import {
  activateLatexEditingTarget,
  clearLatexEditingTarget,
  LatexInlineOwnerContext,
} from "./latexEditingTarget";

const inlineDocument = (source: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: latexTableInlineContent(source) ?? [] }],
});

/** Source adoption is not an edit; outside the component, which the compiler cannot hold. */
function whileAdopting(adopting: { current: boolean }, adopt: () => void) {
  adopting.current = true;
  try {
    adopt();
  } finally {
    adopting.current = false;
  }
}

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
  const [fieldJournal] = useState(createLatexFieldJournal);
  useLayoutEffect(
    () => fieldJournal.observe(props.draftKey, props.source),
    [fieldJournal, props.draftKey, props.source],
  );
  const current = useRef(props);
  const context = useContext(LatexCommandContext);
  const completionContext = useRef(context);
  useLayoutEffect(() => {
    current.current = props;
    completionContext.current = context;
  });
  const { reportDraft } = useContext(LatexDraftContext);
  const id = useId();
  const [initialSource] = useState(() => restoredLatexFieldDraft(props.draftKey, props.source));
  const pending = useRef<string | null>(initialSource === props.source ? null : initialSource);
  const acknowledged = useRef(props.source);
  const root = useRef<HTMLDivElement>(null);
  const innerEditor = useRef<Editor | null>(null);
  const adopting = useRef(false);
  const [publication] = useState(createEditorBackgroundTask);
  const cancelJournal = useRef<(() => void) | null>(null);
  const journal = () => {
    const key = current.current.draftKey;
    if (!key) return;
    if (pending.current === null) fieldJournal.clear(key);
    else fieldJournal.write(key, acknowledged.current, pending.current);
  };
  const publishPending = () => {
    publication.cancel();
    const source = pending.current;
    if (source === null) return true;
    journal();
    if (innerEditor.current?.view.composing) return false;
    if (current.current.disabled || !current.current.onChange(source)) return false;
    acknowledged.current = source;
    pending.current = null;
    reportDraft(id, false);
    journal();
    return true;
  };
  const flushCell = useRef<() => boolean>(() => true);
  // The editor keeps its first configuration; these forward to the latest field state.
  const readField = useStableCallback(() => current.current);
  const readCompletionContext = useStableCallback(() => completionContext.current);
  const filterSourceTransaction = useStableCallback((transaction: Transaction) => {
    if (!transaction.docChanged || adopting.current) return true;
    if (current.current.disabled) return false;
    if (isSourceOwnedTyping(transaction, () => true)) return true;
    if (!flushCell.current()) return false;
    const paragraph = transaction.doc.toJSON().content?.[0];
    const source = paragraph?.content?.length ? serializeLatexVisualBlock(paragraph) : "";
    // Formatting and embedded objects must pass the owning table's
    // source check. Ordinary typing uses the coalesced task instead.
    if (
      source == null ||
      latexTableInlineContent(source) === null ||
      !current.current.onChange(source)
    )
      return false;
    acknowledged.current = source;
    return true;
  });
  const handleFieldKeyDown = useStableCallback((view: EditorView, event: KeyboardEvent) => {
    if (event.isComposing) return false;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (command && (key === "z" || key === "y")) {
      event.preventDefault();
      if (!flushCell.current()) return true;
      return key === "y" || event.shiftKey
        ? current.current.owner.commands.redo()
        : current.current.owner.commands.undo();
    }
    if (event.key === "Tab") {
      event.preventDefault();
      if (flushCell.current()) current.current.onTab(event.shiftKey ? -1 : 1);
      return true;
    }
    if (event.key === "Escape") {
      if (flushCell.current()) current.current.onExit(1);
      return true;
    }
    // A tabular cell is one inline flow; Enter cannot create another table row accidentally.
    if (event.key === "Enter") {
      if (flushCell.current()) current.current.onTab(1);
      return true;
    }
    if (!command && !event.altKey && !event.shiftKey && view.state.selection.empty) {
      const { $from } = view.state.selection;
      if (event.key === "ArrowLeft" && $from.parentOffset === 0) {
        if (flushCell.current()) current.current.onTab(-1);
        return true;
      }
      if (event.key === "ArrowRight" && $from.parentOffset === $from.parent.content.size) {
        if (flushCell.current()) current.current.onTab(1);
        return true;
      }
    }
    return false;
  });
  const handleFieldFocus = useStableCallback((field: Editor) => {
    activateLatexEditingTarget(current.current.owner, field);
    current.current.onFocus();
  });
  const handleFieldBlur = useStableCallback((field: Editor, event: FocusEvent) => {
    flushCell.current();
    const next = event.relatedTarget;
    if (
      next instanceof Element &&
      next.closest(".scient-latex-visual-document") &&
      !root.current?.contains(next)
    )
      clearLatexEditingTarget(current.current.owner, field);
  });
  const handleFieldUpdate = useStableCallback((field: Editor) => {
    const paragraph = field.getJSON().content?.[0];
    const source = paragraph?.content?.length ? serializeLatexVisualBlock(paragraph) : "";
    if (source === null || source === undefined) return;
    pending.current = source === acknowledged.current ? null : source;
    reportDraft(id, pending.current !== null);
    publication.schedule(() => flushCell.current());
    cancelJournal.current?.();
    cancelJournal.current = afterEditorPaint(journal);
  });
  const editor = useEditor({
    shouldRerenderOnTransaction: false,
    extensions: [
      LatexWritingKeys,
      LatexProseCompletion.configure({ context: readCompletionContext }),
      LatexStructuredSelection.configure({
        source: (node) => {
          const field = readField();
          const document = inlineDocument(field.source);
          return latexVisualNodeSignature(document.content[0]!) ===
            latexVisualNodeSignature(node.toJSON())
            ? field.source
            : null;
        },
      }),
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
          undo: () => () => readField().owner.commands.undo(),
          redo: () => () => readField().owner.commands.redo(),
        }),
      }),
      Extension.create({
        name: "objectSourceGuard",
        addProseMirrorPlugins: () => [
          new Plugin({ filterTransaction: (transaction) => filterSourceTransaction(transaction) }),
        ],
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
      handleKeyDown: (view, event) => handleFieldKeyDown(view, event),
    },
    onFocus: ({ editor: field }) => handleFieldFocus(field),
    onBlur: ({ editor: field, event }) => handleFieldBlur(field, event),
    onUpdate: ({ editor: field }) => handleFieldUpdate(field),
  });
  useLayoutEffect(() => {
    innerEditor.current = editor;
    flushCell.current = publishPending;
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
        const { from, to, anchor, head } = editor.state.selection;
        const marks = editor.state.storedMarks;
        whileAdopting(adopting, () =>
          editor.commands.setContent(inlineDocument(props.source), { emitUpdate: false }),
        );
        editor.view.dispatch(
          editor.state.tr
            .setSelection(
              TextSelection.between(
                editor.state.doc.resolve(Math.min(anchor, editor.state.doc.content.size - 1)),
                editor.state.doc.resolve(Math.min(head, editor.state.doc.content.size - 1)),
              ),
            )
            .setStoredMarks(from === to ? marks : null),
        );
        acknowledged.current = props.source;
      });
      return () => {
        cancelled = true;
      };
    }
  }, [editor, props.source, props.disabled, props.label, props.cell]);
  // Listeners belong to one editor; the journal and task they reach are this field's.
  const listenToField = useEffectEvent((..._changes: readonly unknown[]) => {
    if (!editor) return;
    const element = editor.view.dom;
    const replace = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      pending.current = null;
      publication.cancel();
      cancelJournal.current?.();
      acknowledged.current = event.detail;
      whileAdopting(adopting, () =>
        editor.commands.setContent(inlineDocument(event.detail), { emitUpdate: false }),
      );
      reportDraft(id, false);
      const key = current.current.draftKey;
      fieldJournal.clear(key);
    };
    element.addEventListener("scient-latex-replace-field-draft", replace);
    const flush = () => flushCell.current();
    const checkpoint = (event: Event) => {
      if (event instanceof CustomEvent && current.current.draftKey?.startsWith(`${event.detail}:`))
        journal();
    };
    element.addEventListener("scient-latex-flush-field", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("scient-latex-checkpoint-fields", checkpoint);
    return () => {
      element.removeEventListener("scient-latex-replace-field-draft", replace);
      element.removeEventListener("scient-latex-flush-field", flush);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("scient-latex-checkpoint-fields", checkpoint);
      publication.cancel();
      cancelJournal.current?.();
      journal();
    };
  });
  useEffect(() => listenToField(editor, id, reportDraft), [editor, id, reportDraft]);
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
      onFocusCapture={(event) => {
        if (editor && event.currentTarget.contains(event.target))
          activateLatexEditingTarget(props.owner, editor);
      }}
    >
      <LatexInlineOwnerContext value={props.owner}>
        <EditorContent editor={editor} />
      </LatexInlineOwnerContext>
    </div>
  );
}
