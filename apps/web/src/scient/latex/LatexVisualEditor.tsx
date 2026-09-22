import { Extension, Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { NodeViewProps } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { EditorState, Plugin } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { mathSourceCompletions, type MathSourceCompletion } from "./latexMathCompletion";
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

const MATH_BAR_ITEMS = [
  { label: "Fraction", text: "a⁄b", latex: "\\frac{}{}" },
  { label: "Square root", text: "√", latex: "\\sqrt{}" },
  { label: "Superscript", text: "x²", latex: "^{}" },
  { label: "Subscript", text: "x₂", latex: "_{}" },
  { label: "Parentheses", text: "( )", latex: "\\left(\\right)" },
  { label: "Summation", text: "Σ", latex: "\\sum_{}^{}" },
  { label: "Integral", text: "∫", latex: "\\int_{}^{}" },
  { label: "Limit", text: "lim", latex: "\\lim_{}" },
  { label: "Alpha", text: "α", latex: "\\alpha" },
  { label: "Beta", text: "β", latex: "\\beta" },
  { label: "Gamma", text: "γ", latex: "\\gamma" },
  { label: "Theta", text: "θ", latex: "\\theta" },
  { label: "Pi", text: "π", latex: "\\pi" },
  { label: "Infinity", text: "∞", latex: "\\infty" },
  { label: "Less than or equal", text: "≤", latex: "\\le" },
  { label: "Greater than or equal", text: "≥", latex: "\\ge" },
  { label: "Not equal", text: "≠", latex: "\\ne" },
  { label: "Approximately", text: "≈", latex: "\\approx" },
  { label: "Right arrow", text: "→", latex: "\\to" },
] as const;

function mathType(
  attributes: { environment?: string | null; wrapper?: unknown },
  display: boolean,
) {
  if (!display) return attributes.wrapper === "dollar" ? "inline-dollar" : "inline-paren";
  if (attributes.environment) return `environment:${attributes.environment}`;
  return attributes.wrapper === "double-dollar" ? "display-dollar" : "display-bracket";
}

function LatexMathView({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const display = node.type.name === "latexDisplayMath";
  const editable = useEditorEditable(editor);
  const mathField = useRef<LatexMathFieldHandle>(null);
  const sourceEditor = useRef<HTMLTextAreaElement>(null);
  const activationId = useId();
  const attributes = {
    tex: String(node.attrs.tex ?? ""),
    environment: node.attrs.environment ? String(node.attrs.environment) : null,
    wrapper: node.attrs.wrapper,
  } as const;
  const source = latexVisualMathSource(attributes, display);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const completions = useMemo(
    () => mathSourceCompletions(draft, caret).slice(0, 6),
    [caret, draft],
  );

  useEffect(() => {
    const deactivate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== activationId) setEditing(false);
    };
    document.addEventListener("scient-latex-math-activate", deactivate);
    return () => document.removeEventListener("scient-latex-math-activate", deactivate);
  }, [activationId]);

  const activate = () => {
    if (!editable) return;
    document.dispatchEvent(new CustomEvent("scient-latex-math-activate", { detail: activationId }));
    if (!editing) setDraft(source);
    setEditing(true);
    requestAnimationFrame(() => mathField.current?.focus());
  };

  const applySource = () => {
    const parsed = parseLatexVisualMathSource(draft, display);
    if (parsed === null) {
      setSourceError(
        "Keep a complete supported wrapper: $…$, \\(…\\), $$…$$, \\[…\\], equation, align or gather.",
      );
      return;
    }
    updateAttributes(parsed);
    setSourceError(null);
    setDraft(latexVisualMathSource(parsed, display));
  };

  const applyCompletion = (completion: MathSourceCompletion) => {
    const next =
      draft.slice(0, completion.from) + completion.replacement + draft.slice(completion.to);
    const environmentBody = completion.replacement.indexOf("\n\n");
    const emptyArgument = completion.replacement.indexOf("{}");
    const nextCaret =
      completion.from +
      (environmentBody >= 0
        ? environmentBody + 1
        : emptyArgument >= 0
          ? emptyArgument + 1
          : completion.replacement.length);
    setDraft(next);
    setCaret(nextCaret);
    setSourceError(null);
    requestAnimationFrame(() => {
      sourceEditor.current?.focus();
      sourceEditor.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const changeType = (value: string) => {
    const inline = value.startsWith("inline-");
    const nextAttributes = {
      tex: attributes.tex,
      environment: value.startsWith("environment:") ? value.slice("environment:".length) : null,
      wrapper:
        value === "inline-dollar"
          ? "dollar"
          : value === "display-dollar"
            ? "double-dollar"
            : inline
              ? "paren"
              : "bracket",
    } as const;
    if (inline === !display) {
      updateAttributes(nextAttributes);
      setDraft(latexVisualMathSource(nextAttributes, display));
      setSourceError(null);
      return;
    }
    const position = getPos();
    if (position === undefined) return;
    if (display) {
      const inlineNode = editor.schema.nodes.latexInlineMath?.create(nextAttributes);
      const paragraph = inlineNode ? editor.schema.nodes.paragraph?.create(null, inlineNode) : null;
      if (paragraph)
        editor.view.dispatch(
          editor.state.tr.replaceWith(position, position + node.nodeSize, paragraph),
        );
      return;
    }
    const resolved = editor.state.doc.resolve(position);
    if (resolved.parent.childCount !== 1) {
      setSourceError(
        "Centered math can replace an inline formula only when it is alone on its line.",
      );
      return;
    }
    const displayNode = editor.schema.nodes.latexDisplayMath?.create(nextAttributes);
    if (displayNode)
      editor.view.dispatch(
        editor.state.tr.replaceWith(resolved.before(), resolved.after(), displayNode),
      );
  };

  const toolbar = editing
    ? createPortal(
        <div className="scient-latex-math-bar" role="toolbar" aria-label="Math tools">
          <span className="scient-latex-math-bar-title">Math</span>
          <div className="scient-latex-math-bar-scroll">
            {MATH_BAR_ITEMS.map((item) => (
              <ScientTooltip key={item.label} content={item.label}>
                <button
                  type="button"
                  aria-label={item.label}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => mathField.current?.insert(item.latex)}
                >
                  {item.text}
                </button>
              </ScientTooltip>
            ))}
            <select
              aria-label="Insert math structure"
              value=""
              onChange={(event) => {
                const latex = event.currentTarget.value;
                if (latex) mathField.current?.insert(latex);
                event.currentTarget.value = "";
              }}
            >
              <option value="">Structure…</option>
              <option value="\\begin{bmatrix} & \\\\ & \\end{bmatrix}">Bracket matrix</option>
              <option value="\\begin{pmatrix} & \\\\ & \\end{pmatrix}">Parentheses matrix</option>
              <option value="\\begin{cases} & \\\\ & \\end{cases}">Cases</option>
              <option value="\\begin{aligned} &amp;= \\\\ &amp;= \\end{aligned}">
                Aligned equations
              </option>
            </select>
          </div>
          <button
            className="scient-latex-math-bar-done"
            type="button"
            onClick={() => setEditing(false)}
          >
            Done
          </button>
        </div>,
        document.body,
      )
    : null;
  return (
    <NodeViewWrapper
      as={display ? "div" : "span"}
      className={display ? "scient-latex-visual-display-math" : "scient-latex-visual-inline-math"}
      contentEditable={false}
      data-selected={selected || editing || undefined}
      onClick={activate}
    >
      <LatexMathField
        ref={mathField}
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
            <select
              aria-label="Equation type"
              value={mathType(attributes, display)}
              onChange={(event) => changeType(event.currentTarget.value)}
            >
              <option value="inline-paren">{"Inline · \\(…\\)"}</option>
              <option value="inline-dollar">Inline · $…$</option>
              <option value="display-bracket">{"Centered · \\[…\\]"}</option>
              <option value="display-dollar">Centered · $$…$$</option>
              <option value="environment:equation">Equation · numbered</option>
              <option value="environment:equation*">Equation · unnumbered</option>
              <option value="environment:align">Align · numbered</option>
              <option value="environment:align*">Align · unnumbered</option>
              <option value="environment:gather">Gather · numbered</option>
              <option value="environment:gather*">Gather · unnumbered</option>
            </select>
          </div>
          <textarea
            ref={sourceEditor}
            aria-label="Complete LaTeX equation source"
            value={draft}
            rows={display ? Math.min(10, Math.max(3, draft.split("\n").length)) : 2}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setCaret(event.currentTarget.selectionStart);
              setSourceError(null);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(source);
                setSourceError(null);
                setEditing(false);
              } else if (event.key === "Tab" && completions[0]) {
                event.preventDefault();
                applyCompletion(completions[0]);
              } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                applySource();
              }
            }}
          />
          {completions.length > 0 ? (
            <div
              className="scient-latex-math-completions"
              role="listbox"
              aria-label="LaTeX completions"
            >
              {completions.map((completion) => (
                <button
                  key={completion.label}
                  type="button"
                  role="option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyCompletion(completion)}
                >
                  <code>{completion.label}</code>
                </button>
              ))}
              <span>Tab accepts</span>
            </div>
          ) : null}
          {sourceError ? (
            <div className="scient-latex-math-source-error" role="alert">
              {sourceError}
            </div>
          ) : null}
          <div className="scient-latex-math-source-actions">
            <span>Ctrl+Enter to apply · Escape to cancel</span>
            <button
              type="button"
              onClick={() => {
                setDraft(source);
                setSourceError(null);
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
      {toolbar}
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

function withStableKeys<T>(values: T[], serialize: (value: T) => string) {
  const occurrences = new Map<string, number>();
  return values.map((value, index) => {
    const serialized = serialize(value);
    const occurrence = occurrences.get(serialized) ?? 0;
    occurrences.set(serialized, occurrence + 1);
    return { index, key: `${serialized}\u0000${occurrence}`, value };
  });
}

function LatexRichPreviewView({ node, selected, updateAttributes, editor }: NodeViewProps) {
  const editorEditable = useEditorEditable(editor);
  const generatedId = useRef(0);
  const kind = node.attrs.kind === "table" ? "table" : "description";
  const items = Array.isArray(node.attrs.items)
    ? (node.attrs.items as { label?: unknown; body?: unknown }[])
    : [];
  const itemIds = Array.isArray(node.attrs.itemIds)
    ? (node.attrs.itemIds as unknown[]).map(String)
    : [];
  const rows = Array.isArray(node.attrs.rows)
    ? (node.attrs.rows as unknown[]).filter(Array.isArray).map((row) => row.map(String))
    : [];
  const rowIds = Array.isArray(node.attrs.rowIds)
    ? (node.attrs.rowIds as unknown[]).map(String)
    : [];
  const caption = String(node.attrs.caption ?? "Table");
  const structureEditable = node.attrs.editable === true;
  const tableEditable = kind === "table" && structureEditable;
  const descriptionEditable = kind === "description" && structureEditable;
  const sourceMeta =
    node.attrs.sourceMeta && typeof node.attrs.sourceMeta === "object"
      ? (node.attrs.sourceMeta as Record<string, unknown>)
      : null;
  const captionEditable = tableEditable && sourceMeta !== null && sourceMeta.captionRange !== null;
  const nextGeneratedId = (prefix: string) => {
    generatedId.current += 1;
    return `${prefix}-${generatedId.current}`;
  };
  const keyedItems = descriptionEditable
    ? items.map((item, index) => ({
        index,
        key: itemIds[index] ?? `description-item-${index}`,
        value: item,
      }))
    : withStableKeys(items, (item) => JSON.stringify([item.label, item.body]));
  const keyedRows = tableEditable
    ? rows.map((row, index) => ({
        index,
        key: rowIds[index] ?? `table-row-${index}`,
        value: row,
      }))
    : withStableKeys(rows, (row) => JSON.stringify(row));
  const updateDescriptionItem = (index: number, field: "label" | "body", value: string) => {
    if (!editorEditable || !descriptionEditable) return;
    const nextItems = items.map((item) => ({ ...item }));
    nextItems[index] = { ...nextItems[index], [field]: value };
    updateAttributes({ items: nextItems });
  };
  const addDescriptionItem = () => {
    if (!editorEditable || !descriptionEditable) return;
    updateAttributes({
      items: [...items, { label: "New item", body: "Describe this item." }],
      itemIds: [...itemIds, nextGeneratedId("description-new")],
    });
  };
  const removeDescriptionItem = (index: number) => {
    if (!editorEditable || !descriptionEditable || items.length <= 1) return;
    updateAttributes({
      items: items.filter((_, itemIndex) => itemIndex !== index),
      itemIds: itemIds.filter((_, itemIndex) => itemIndex !== index),
    });
  };
  const updateCell = (rowIndex: number, cellIndex: number, value: string) => {
    if (!editorEditable || !tableEditable) return;
    const nextRows = rows.map((row) => [...row]);
    nextRows[rowIndex]![cellIndex] = value;
    updateAttributes({ rows: nextRows });
  };
  const addTableRow = () => {
    if (!editorEditable || !tableEditable || rows.length === 0) return;
    const width = rows[0]!.length;
    updateAttributes({
      rows: [...rows, Array.from({ length: width }, (_, index) => (index === 0 ? "New row" : ""))],
      rowIds: [...rowIds, nextGeneratedId("table-new")],
    });
  };
  return (
    <NodeViewWrapper
      className="scient-latex-rich-preview"
      data-kind={kind}
      data-selected={selected || undefined}
      contentEditable={false}
    >
      <div className="scient-latex-rich-preview-label">
        <span>{kind === "table" ? "Table preview" : "Description list"}</span>
        <span>
          {structureEditable
            ? "Editable structure - LaTeX preserved"
            : "Protected source - edit in Source"}
        </span>
      </div>
      {kind === "description" ? (
        <>
          <dl>
            {keyedItems.map(({ index, key, value: item }) => (
              <div key={key}>
                <dt>
                  {descriptionEditable ? (
                    <input
                      aria-label={`Description item ${index + 1} label`}
                      disabled={!editorEditable}
                      value={String(item.label ?? "")}
                      onChange={(event) =>
                        updateDescriptionItem(index, "label", event.currentTarget.value)
                      }
                    />
                  ) : (
                    String(item.label ?? "")
                  )}
                </dt>
                <dd>
                  {descriptionEditable ? (
                    <textarea
                      aria-label={`Description item ${index + 1} body`}
                      disabled={!editorEditable}
                      rows={2}
                      value={String(item.body ?? "")}
                      onChange={(event) =>
                        updateDescriptionItem(index, "body", event.currentTarget.value)
                      }
                    />
                  ) : (
                    String(item.body ?? "")
                  )}
                </dd>
                {descriptionEditable ? (
                  <button
                    aria-label={`Remove description item ${index + 1}`}
                    className="scient-latex-structure-remove"
                    disabled={!editorEditable || items.length <= 1}
                    onClick={() => removeDescriptionItem(index)}
                    type="button"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
          </dl>
          {descriptionEditable ? (
            <div className="scient-latex-structure-actions">
              <button disabled={!editorEditable} onClick={addDescriptionItem} type="button">
                Add item
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <figure>
          <figcaption>
            {captionEditable ? (
              <input
                aria-label="Table caption"
                disabled={!editorEditable}
                value={caption}
                onChange={(event) => updateAttributes({ caption: event.currentTarget.value })}
              />
            ) : (
              caption
            )}
          </figcaption>
          <div className="scient-latex-rich-table-scroll">
            <table>
              <tbody>
                {keyedRows.map(({ index: rowIndex, key, value: row }) => (
                  <tr key={key}>
                    {(tableEditable
                      ? row.map((cell, index) => ({
                          index,
                          key: `${rowIds[rowIndex] ?? rowIndex}-${index}`,
                          value: cell,
                        }))
                      : withStableKeys(row, String)
                    ).map(({ index: cellIndex, key: cellKey, value: cell }) => {
                      const content = tableEditable ? (
                        <input
                          aria-label={`Table row ${rowIndex + 1} column ${cellIndex + 1}`}
                          disabled={!editorEditable}
                          value={cell}
                          onChange={(event) =>
                            updateCell(rowIndex, cellIndex, event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape") event.currentTarget.blur();
                          }}
                        />
                      ) : (
                        cell
                      );
                      return rowIndex === 0 ? (
                        <th key={cellKey} scope="col">
                          {content}
                        </th>
                      ) : (
                        <td key={cellKey}>{content}</td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tableEditable ? (
            <div className="scient-latex-structure-actions">
              <button disabled={!editorEditable} onClick={addTableRow} type="button">
                Add row
              </button>
            </div>
          ) : null}
        </figure>
      )}
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

const LatexRichPreview = Node.create({
  name: "latexRichPreview",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: "description" },
      raw: { default: "" },
      items: { default: null },
      rows: { default: null },
      cellRanges: { default: null, rendered: false },
      sourceMeta: { default: null, rendered: false },
      itemIds: { default: null, rendered: false },
      rowIds: { default: null, rendered: false },
      editable: { default: false, rendered: false },
      caption: { default: null },
      sourceId: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-latex-rich-preview]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-latex-rich-preview": "" }];
  },
  addNodeView() {
    return ReactNodeViewRenderer(LatexRichPreviewView);
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
  LatexRichPreview,
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
          Click rendered math to edit it with the contextual math bar. Its compact popover shows the
          complete LaTeX, changes inline, centered and numbered forms, and completes common commands
          or environments with Tab. Insert matrices, cases and aligned equations from the Insert
          menu, or type a complete supported environment to convert it. Source-only blocks stay
          protected. Page breaks, numbering, packages and macro output are verified in PDF after
          Rebuild.
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
