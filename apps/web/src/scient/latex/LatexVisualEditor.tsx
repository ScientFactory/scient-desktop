import { Extension, Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { NodeViewProps } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { EditorState, Plugin } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { LatexMathField } from "./LatexMathField";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { readVisualDraft, clearVisualDraft } from "./visualDrafts";

import {
  applyLatexVisualDocumentChange,
  latexVisualMathSource,
  parseLatexVisualMathSource,
  parseStructuredMathEnvironment,
  projectLatexVisualDocument,
  type LatexVisualDocument,
} from "./latexVisualDocument";

const LatexSourceAttributes = Extension.create({
  name: "latexSourceAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "bulletList", "orderedList"],
        attributes: {
          sourceId: { default: null, rendered: false },
          latexCommand: { default: null, rendered: false },
          unnumbered: { default: false, rendered: false },
        },
      },
    ];
  },
});

function useEditorEditable(editor: Editor): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      editor.on("update", changed);
      return () => {
        editor.off("update", changed);
      };
    },
    [editor],
  );
  return useSyncExternalStore(
    subscribe,
    () => editor.isEditable,
    () => false,
  );
}

function LatexMathView({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const display = node.type.name === "latexDisplayMath";
  const editable = useEditorEditable(editor);
  const attributes = {
    tex: String(node.attrs.tex ?? ""),
    environment: node.attrs.environment ? String(node.attrs.environment) : null,
    wrapper: node.attrs.wrapper,
  } as const;
  const source = latexVisualMathSource(attributes, display);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [sourceError, setSourceError] = useState(false);

  const applySource = () => {
    const parsed = parseLatexVisualMathSource(draft, display);
    if (parsed === null) {
      setSourceError(true);
      return;
    }
    updateAttributes(parsed);
    setSourceError(false);
    setEditing(false);
  };
  return (
    <NodeViewWrapper
      as={display ? "div" : "span"}
      className={display ? "scient-latex-visual-display-math" : "scient-latex-visual-inline-math"}
      contentEditable={false}
      data-selected={selected || editing || undefined}
      onClick={() => {
        if (editable) {
          if (!editing) setDraft(source);
          setEditing(true);
        }
      }}
    >
      <LatexMathField
        value={attributes.tex}
        display={display}
        disabled={!editable || !editing}
        onChange={(tex) => {
          if (editor.isEditable) {
            updateAttributes({ tex });
            setDraft(latexVisualMathSource({ ...attributes, tex }, display));
          }
          const position = getPos();
          return String(
            (position === undefined ? node : editor.state.doc.nodeAt(position))?.attrs.tex ??
              node.attrs.tex ??
              "",
          );
        }}
      />
      {editing ? (
        <div
          className="scient-latex-math-source-popover"
          role="dialog"
          aria-label="Equation source"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="scient-latex-math-source-heading">
            <span>LaTeX equation</span>
            <span>{display ? "Display math" : "Inline math"}</span>
          </div>
          <textarea
            autoFocus
            aria-label="Complete LaTeX equation source"
            value={draft}
            rows={display ? Math.min(10, Math.max(3, draft.split("\n").length)) : 2}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setSourceError(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(source);
                setSourceError(false);
                setEditing(false);
              } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                applySource();
              }
            }}
          />
          {sourceError ? (
            <div className="scient-latex-math-source-error" role="alert">
              Keep the complete supported wrapper: $…$, \(…\), $$…$$, \[…\], equation, align or
              gather.
            </div>
          ) : null}
          <div className="scient-latex-math-source-actions">
            <span>Ctrl+Enter to apply · Escape to cancel</span>
            <button
              type="button"
              onClick={() => {
                setDraft(source);
                setSourceError(false);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="button" onClick={applySource}>
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

function LatexInlineCommandView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const editable = useEditorEditable(editor);
  const name = String(node.attrs.name ?? "command");
  const argument = String(node.attrs.argument ?? "");
  const [editing, setEditing] = useState(false);
  return (
    <NodeViewWrapper
      as="span"
      className="scient-latex-visual-command"
      data-selected={selected || undefined}
      contentEditable={false}
    >
      {editing ? (
        <input
          autoFocus
          aria-label={`${name} argument`}
          value={argument}
          onChange={(event) => {
            const next = event.currentTarget.value;
            if (!editor.isEditable || /[{}\\%]/u.test(next)) return;
            updateAttributes({ argument: next, raw: `\\${name}{${next}}` });
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
          }}
        />
      ) : (
        <button
          type="button"
          disabled={!editable}
          onClick={() => setEditing(true)}
          aria-label={`Edit ${name}`}
        >
          <span className="scient-latex-visual-command-name">{name}</span>
          <span>{argument || "empty"}</span>
        </button>
      )}
    </NodeViewWrapper>
  );
}

function LatexRawBlockView({ node }: NodeViewProps) {
  const raw = String(node.attrs.raw ?? "");
  return (
    <NodeViewWrapper className="scient-latex-visual-raw" contentEditable={false}>
      <div className="scient-latex-visual-raw-label">
        Preserved LaTeX · use Edit LaTeX to change this block
      </div>
      <pre>{raw}</pre>
    </NodeViewWrapper>
  );
}

const LatexInlineMath = Node.create({
  name: "latexInlineMath",
  group: "inline",
  inline: true,
  marks: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return { tex: { default: "" }, wrapper: { default: "paren" } };
  },
  parseHTML() {
    return [{ tag: "span[data-latex-inline-math]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, "data-latex-inline-math": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexMathView);
  },
});

const LatexDisplayMath = Node.create({
  name: "latexDisplayMath",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      tex: { default: "" },
      environment: { default: null },
      wrapper: { default: "bracket" },
      sourceId: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-latex-display-math]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-latex-display-math": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexMathView);
  },
});

const LatexInlineCommand = Node.create({
  name: "latexInlineCommand",
  group: "inline",
  inline: true,
  marks: "",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: { default: "command" },
      argument: { default: "" },
      raw: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-latex-command]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, "data-latex-command": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexInlineCommandView);
  },
});

const LatexRawBlock = Node.create({
  name: "latexRawBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      raw: { default: "" },
      label: { default: "Raw LaTeX" },
      sourceId: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-latex-raw]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-latex-raw": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexRawBlockView);
  },
});

const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    link: false,
    strike: false,
    underline: false,
    trailingNode: false,
  }),
  LatexSourceAttributes,
  LatexInlineMath,
  LatexDisplayMath,
  LatexInlineCommand,
  LatexRawBlock,
];

const MATH_INSERTIONS = {
  equation: "E = mc^2",
  bmatrix: "\\begin{bmatrix}\na & b \\\\\nc & d\n\\end{bmatrix}",
  pmatrix: "\\begin{pmatrix}\na & b \\\\\nc & d\n\\end{pmatrix}",
  cases: "\\begin{cases}\nf(x), & x > 0 \\\\\n0, & x = 0\n\\end{cases}",
  aligned: "\\begin{aligned}\na &= b + c \\\\\nd &= e + f\n\\end{aligned}",
} as const;

export interface LatexVisualEditorProps {
  readonly draftKey: string;
  readonly fileRevision: string;
  readonly source: string;
  readonly disabled: boolean;
  readonly onEdit: (expected: string, next: string) => boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly onOpenSource: () => void;
  readonly registerFinishEditing?: (finish: (() => void) | null) => void;
}

export function LatexVisualEditor(props: LatexVisualEditorProps) {
  const [recovery, setRecovery] = useState(() =>
    readVisualDraft(props.draftKey, { source: props.source, revision: props.fileRevision }),
  );
  const readOnly = props.disabled || recovery !== null;
  const [initial] = useState(() => projectLatexVisualDocument(props.source));
  const projection = useRef<LatexVisualDocument>(initial);
  const currentSource = useRef(props.source);
  const onEdit = useRef(props.onEdit);
  const applying = useRef(false);
  const accepted = useRef<{
    doc: ProseMirrorNode;
    expected: string;
    change: NonNullable<ReturnType<typeof applyLatexVisualDocumentChange>>;
  } | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const [, refreshToolbar] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState({
    supported: initial.supportedBlocks,
    raw: initial.rawBlocks,
  });

  useLayoutEffect(() => {
    onEdit.current = props.onEdit;
  }, [props.onEdit]);

  const installProjection = useCallback((next: LatexVisualDocument, resetEditor: boolean) => {
    projection.current = next;
    setSummary({ supported: next.supportedBlocks, raw: next.rawBlocks });
    const editor = editorRef.current;
    if (!resetEditor || !editor) return;
    applying.current = true;
    editor.commands.setContent(next.content, { emitUpdate: false });
    applying.current = false;
  }, []);

  const handleUpdate = useCallback(
    (doc: ProseMirrorNode) => {
      if (applying.current) return;
      const expected = currentSource.current;
      const cached = accepted.current;
      const changed =
        cached?.doc === doc && cached.expected === expected
          ? cached.change
          : applyLatexVisualDocumentChange(expected, projection.current, doc.toJSON());
      accepted.current = null;
      if (changed === null) {
        setNotice("That structure is source-only. Your LaTeX was not changed.");
        installProjection(projection.current, true);
        return;
      }
      if (changed.source === expected) return;
      if (!onEdit.current(expected, changed.source)) {
        setNotice("The source changed elsewhere. Visual reloaded the current LaTeX.");
        installProjection(projectLatexVisualDocument(currentSource.current), true);
        return;
      }
      currentSource.current = changed.source;
      installProjection(changed.projection, false);
      setNotice(null);
    },
    [installProjection],
  );
  const handleUpdateRef = useRef(handleUpdate);
  useLayoutEffect(() => {
    handleUpdateRef.current = handleUpdate;
  }, [handleUpdate]);

  const guardedExtensions = useMemo(
    () => [
      ...extensions,
      Extension.create({
        name: "latexSourceGuard",
        addProseMirrorPlugins() {
          return [
            new Plugin({
              appendTransaction(transactions, _previousState, nextState) {
                if (!transactions.some((transaction) => transaction.docChanged)) return null;
                const { $from } = nextState.selection;
                if ($from.parent.type.name !== "paragraph") return null;
                if (!$from.parent.content.content.every((child) => child.isText)) return null;
                const tex = parseStructuredMathEnvironment($from.parent.textContent);
                if (tex === null) return null;
                const from = $from.before();
                const to = $from.after();
                const math = nextState.schema.nodes.latexDisplayMath?.create({
                  tex,
                  wrapper: "bracket",
                });
                return math ? nextState.tr.replaceWith(from, to, math) : null;
              },
              filterTransaction(transaction) {
                if (!transaction.docChanged || applying.current) return true;
                const change = applyLatexVisualDocumentChange(
                  currentSource.current,
                  projection.current,
                  transaction.doc.toJSON(),
                );
                const supported = change !== null;
                if (change)
                  accepted.current = {
                    doc: transaction.doc,
                    expected: currentSource.current,
                    change,
                  };
                if (!supported)
                  setNotice(
                    "This edit crosses source-only LaTeX. Use Edit LaTeX for that structure; no source was changed.",
                  );
                return supported;
              },
            }),
          ];
        },
      }),
    ],
    [],
  );

  const editor = useEditor({
    extensions: guardedExtensions,
    enableInputRules: false,
    enablePasteRules: false,
    content: initial.content,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: "scient-latex-visual-document",
        "aria-label": "Visual LaTeX document editor",
      },
    },
    onUpdate: ({ editor: updated }) => handleUpdateRef.current(updated.state.doc),
    onSelectionUpdate: () => refreshToolbar((value) => value + 1),
    onTransaction: () => refreshToolbar((value) => value + 1),
  });

  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (props.source === currentSource.current) return;
    currentSource.current = props.source;
    installProjection(projectLatexVisualDocument(props.source), true);
    if (editor)
      editor.view.updateState(
        EditorState.create({
          schema: editor.schema,
          doc: editor.state.doc,
          plugins: editor.state.plugins,
        }),
      );
    setNotice(null);
  }, [editor, installProjection, props.source]);

  const registerFinishEditing = props.registerFinishEditing;
  useLayoutEffect(() => {
    registerFinishEditing?.(() => editor?.commands.blur());
    return () => registerFinishEditing?.(null);
  }, [editor, registerFinishEditing]);

  const onEditingChange = props.onEditingChange;
  useEffect(() => () => onEditingChange(false), [onEditingChange]);

  const insertDisplayMath = (tex: string) =>
    editor
      ?.chain()
      .focus()
      .insertContent({ type: "latexDisplayMath", attrs: { tex, wrapper: "bracket" } })
      .run();

  return (
    <div
      className="scient-latex-visual-workspace"
      onFocusCapture={() => props.onEditingChange(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) props.onEditingChange(false);
      }}
    >
      {recovery === null ? null : (
        <div className="scient-latex-visual-recovery" role="alert">
          <label>
            Recovered unsaved source — the file has not been replaced.
            <textarea aria-label="Recover unapplied visual source" readOnly value={recovery} />
          </label>
          <button
            type="button"
            onClick={() => {
              clearVisualDraft(props.draftKey);
              setRecovery(null);
            }}
          >
            Dismiss recovered draft
          </button>
        </div>
      )}
      <div className="scient-latex-writing-toolbar" role="toolbar" aria-label="Document formatting">
        <div className="scient-latex-toolbar-group" aria-label="Text style">
          <select
            aria-label="Paragraph style"
            disabled={readOnly || recovery !== null || !editor}
            value={
              editor?.isActive("heading")
                ? String(editor.getAttributes("heading").level)
                : "paragraph"
            }
            onChange={(event) => {
              if (event.target.value === "paragraph") editor?.chain().focus().setParagraph().run();
              else
                editor
                  ?.chain()
                  .focus()
                  .setHeading({ level: Number(event.target.value) as 1 | 2 | 3 })
                  .run();
            }}
          >
            <option value="paragraph">Normal text</option>
            <option value="1">Heading 1</option>
            <option value="2">Heading 2</option>
            <option value="3">Heading 3</option>
          </select>
          {[
            [
              "Bold",
              "B",
              () => editor?.chain().focus().toggleBold().run(),
              editor?.isActive("bold"),
            ],
            [
              "Italic",
              "I",
              () => editor?.chain().focus().toggleItalic().run(),
              editor?.isActive("italic"),
            ],
            [
              "Bullet list",
              "• List",
              () => editor?.chain().focus().toggleBulletList().run(),
              editor?.isActive("bulletList"),
            ],
            [
              "Numbered list",
              "1. List",
              () => editor?.chain().focus().toggleOrderedList().run(),
              editor?.isActive("orderedList"),
            ],
            ["Undo", "↶", () => editor?.chain().focus().undo().run(), false],
            ["Redo", "↷", () => editor?.chain().focus().redo().run(), false],
          ].map(([label, text, action, active]) => (
            <ScientTooltip key={String(label)} content={String(label)}>
              <button
                type="button"
                aria-label={String(label)}
                aria-pressed={Boolean(active)}
                disabled={readOnly || !editor}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => (action as () => void)()}
              >
                {String(text)}
              </button>
            </ScientTooltip>
          ))}
        </div>
        <div className="scient-latex-toolbar-group" aria-label="Insert mathematics">
          <button
            type="button"
            disabled={readOnly}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "latexInlineMath",
                  attrs: { tex: "x", wrapper: "paren" },
                })
                .run()
            }
          >
            Inline math
          </button>
          <select
            aria-label="Insert equation or math environment"
            disabled={readOnly}
            value=""
            onChange={(event) => {
              const key = event.currentTarget.value as keyof typeof MATH_INSERTIONS;
              if (key) insertDisplayMath(MATH_INSERTIONS[key]);
              event.currentTarget.value = "";
            }}
          >
            <option value="">Insert…</option>
            <option value="equation">Display equation</option>
            <option value="bmatrix">Bracket matrix</option>
            <option value="pmatrix">Parentheses matrix</option>
            <option value="cases">Cases</option>
            <option value="aligned">Aligned equations</option>
          </select>
        </div>
        <div className="scient-latex-toolbar-spacer" />
        <button className="scient-latex-source-button" type="button" onClick={props.onOpenSource}>
          Source
        </button>
      </div>
      <div className="scient-latex-visual-summary" role="status">
        <span>{readOnly ? "Read-only" : "Writing view · approximate layout"}</span>
        <span>
          {summary.supported} visual {summary.supported === 1 ? "block" : "blocks"}
        </span>
        {summary.raw > 0 ? (
          <span>
            {summary.raw} source-only {summary.raw === 1 ? "block" : "blocks"}
          </span>
        ) : null}
      </div>
      <details className="scient-latex-writing-help">
        <summary>What can I edit here?</summary>
        <p>
          Write text, headings, formatting, lists, citations, references and equations directly.
          Click rendered math to open its complete LaTeX source and math keyboard. Insert matrices,
          cases and aligned equations from the Insert menu, or type a complete supported environment
          to convert it. Source-only blocks stay protected. Page breaks, numbering, packages and
          macro output are verified in PDF after Rebuild.
        </p>
      </details>
      {notice === null ? null : (
        <div className="scient-latex-visual-notice" role="alert">
          {notice}
        </div>
      )}
      <div className="scient-latex-visual-scroll">
        <div className="scient-latex-visual-paper">
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}
