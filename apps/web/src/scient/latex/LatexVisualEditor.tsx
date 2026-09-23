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
  type CSSProperties,
  type FocusEvent,
} from "react";
import { createPortal } from "react-dom";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import { EditorState, Plugin } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { mathSourceCompletions, type MathSourceCompletion } from "./latexMathCompletion";
import { planLatexVisualPagination } from "./latexVisualPagination";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useAssetUrlState } from "~/assets/assetUrls";
import { readVisualDraft, clearVisualDraft } from "./visualDrafts";

import {
  applyLatexVisualDocumentChange,
  latexVisualFigureSource,
  latexVisualLayoutProfile,
  latexVisualScientificSource,
  latexVisualTableSource,
  latexVisualMathSource,
  parseLatexVisualMathSource,
  parseStructuredMathEnvironment,
  projectLatexVisualDocument,
  updateLatexVisualLayoutSource,
  type LatexVisualDocument,
  type LatexVisualTablePreset,
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
          unnumbered: {
            default: false,
            rendered: true,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.unnumbered === true ? { "data-latex-unnumbered": "" } : {},
          },
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
  const [sourceOpen, setSourceOpen] = useState(false);
  const [draft, setDraft] = useState(source);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const completions = useMemo(
    () => mathSourceCompletions(draft, caret).slice(0, 6),
    [caret, draft],
  );

  useEffect(() => {
    const deactivate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== activationId) {
        setEditing(false);
        setSourceOpen(false);
      }
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
          <select
            aria-label="Equation type"
            value={mathType(attributes, display)}
            onChange={(event) => changeType(event.currentTarget.value)}
          >
            <option value="inline-paren">Inline</option>
            <option value="inline-dollar">Inline ($)</option>
            <option value="display-bracket">Centered</option>
            <option value="display-dollar">Centered ($$)</option>
            <option value="environment:equation">Equation - numbered</option>
            <option value="environment:equation*">Equation - unnumbered</option>
            <option value="environment:align">Align - numbered</option>
            <option value="environment:align*">Align - unnumbered</option>
            <option value="environment:gather">Gather - numbered</option>
            <option value="environment:gather*">Gather - unnumbered</option>
          </select>
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
            className="scient-latex-math-bar-source"
            aria-pressed={sourceOpen}
            type="button"
            onClick={() => setSourceOpen((open) => !open)}
          >
            LaTeX
          </button>
          <button
            className="scient-latex-math-bar-done"
            type="button"
            onClick={() => {
              setSourceOpen(false);
              setEditing(false);
            }}
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
      {editing && sourceOpen ? (
        <div
          className="scient-latex-math-source-popover"
          role="dialog"
          aria-label="Equation source"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="scient-latex-math-source-heading">
            <span>LaTeX equation</span>
            <select
              aria-label="Equation source type"
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

function visualTodayLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

interface LatexVisualWorkspace {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
}

function normalizeFigurePath(sourceRelativePath: string, figurePath: string): string | null {
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[A-Za-z]:[\\/]|[\\/])/u.test(figurePath)) return null;
  const directory = sourceRelativePath.replaceAll("\\", "/").split("/").slice(0, -1);
  const segments = [...directory, ...figurePath.replaceAll("\\", "/").split("/")];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
    } else normalized.push(segment);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

function visualFigureWidth(width: string): string | undefined {
  const relative = /^\s*(?:(\d+(?:\.\d*)?|\.\d+)\s*)?\\(?:textwidth|linewidth)\s*$/u.exec(width);
  if (relative) return `${Math.min(1, Number(relative[1] ?? "1")) * 100}%`;
  const absolute = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(in|cm|mm|pt)\s*$/u.exec(width);
  return absolute ? `${absolute[1]}${absolute[2]}` : undefined;
}

function LatexFigureImage(props: {
  readonly alt: string;
  readonly path: string;
  readonly width: string;
  readonly workspace: LatexVisualWorkspace;
}) {
  const relativePath =
    props.workspace.relativePath === null
      ? null
      : normalizeFigurePath(props.workspace.relativePath, props.path);
  const resource = useMemo<AssetResource | null>(
    () =>
      props.workspace.cwd === null || relativePath === null
        ? null
        : {
            _tag: "workspace-file",
            cwd: props.workspace.cwd,
            relativePath,
          },
    [props.workspace.cwd, relativePath],
  );
  const asset = useAssetUrlState(props.workspace.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const style = { width: visualFigureWidth(props.width) };
  if (asset._tag === "Success" && failedUrl !== asset.url)
    return (
      <img
        alt={props.alt || props.path}
        draggable={false}
        onError={() => setFailedUrl(asset.url)}
        src={asset.url}
        style={style}
      />
    );
  const failed = asset._tag === "Failure" || failedUrl !== null;
  return (
    <div
      className="scient-latex-figure-placeholder"
      role="img"
      aria-label={props.alt || props.path}
      style={style}
    >
      <span>{failed ? "Image preview unavailable" : "Loading image preview…"}</span>
      <code>{props.path || "Choose a project image"}</code>
      {failed ? (
        <button
          onClick={() => {
            setFailedUrl(null);
            asset.refresh();
          }}
          type="button"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function LatexRichPreviewView({
  node,
  selected,
  updateAttributes,
  editor,
  deleteNode,
  workspace,
}: NodeViewProps & { readonly workspace: LatexVisualWorkspace }) {
  const editorEditable = useEditorEditable(editor);
  const generatedId = useRef(0);
  const tableRoot = useRef<HTMLElement | null>(null);
  const [selectedCell, setSelectedCell] = useState({ row: 0, column: 0 });
  const [objectActive, setObjectActive] = useState(false);
  const [addingAuthor, setAddingAuthor] = useState(false);
  const kind = String(node.attrs.kind ?? "description");
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
  const columnIds = Array.isArray(node.attrs.columnIds)
    ? (node.attrs.columnIds as unknown[]).map(String)
    : [];
  const columnAlignments = Array.isArray(node.attrs.columnAlignments)
    ? (node.attrs.columnAlignments as unknown[]).map((alignment) =>
        alignment === "center" || alignment === "right" ? alignment : "left",
      )
    : [];
  const caption = String(node.attrs.caption ?? "");
  const tableLabel = String(node.attrs.label ?? "");
  const structureEditable = node.attrs.editable === true;
  const controlsVisible = selected || objectActive;
  const tableEditable = kind === "table" && structureEditable;
  const descriptionEditable = kind === "description" && structureEditable;
  const sourceMeta =
    node.attrs.sourceMeta && typeof node.attrs.sourceMeta === "object"
      ? (node.attrs.sourceMeta as Record<string, unknown>)
      : null;
  const hasTableFloat = sourceMeta?.hasFloat === true;
  const captionEditable =
    tableEditable && sourceMeta !== null && (sourceMeta.captionRange !== null || hasTableFloat);
  const labelEditable =
    tableEditable && sourceMeta !== null && (sourceMeta.labelRange !== null || hasTableFloat);
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
  const updateTableStructure = (attributes: Record<string, unknown>) => {
    if (!editorEditable || !tableEditable) return;
    updateAttributes({ ...attributes, tableCanonical: true });
  };
  const focusTableCell = (row: number, column: number) => {
    requestAnimationFrame(() => {
      tableRoot.current
        ?.querySelector<HTMLTextAreaElement>(`[data-table-cell="${row}-${column}"]`)
        ?.focus();
    });
  };
  const addTableRow = (after = selectedCell.row) => {
    if (!editorEditable || !tableEditable || rows.length === 0) return;
    const insertion = Math.min(rows.length, Math.max(0, after + 1));
    const nextRows = rows.map((row) => [...row]);
    const nextRowIds = [...rowIds];
    nextRows.splice(
      insertion,
      0,
      Array.from({ length: rows[0]!.length }, () => ""),
    );
    nextRowIds.splice(insertion, 0, nextGeneratedId("table-row"));
    setSelectedCell({ row: insertion, column: 0 });
    updateTableStructure({ rows: nextRows, rowIds: nextRowIds });
    focusTableCell(insertion, 0);
  };
  const removeTableRow = () => {
    if (rows.length <= 1) return;
    const row = Math.min(selectedCell.row, rows.length - 1);
    const nextRows = rows.filter((_, index) => index !== row);
    const nextRowIds = rowIds.filter((_, index) => index !== row);
    const nextSelection = { row: Math.min(row, nextRows.length - 1), column: selectedCell.column };
    setSelectedCell(nextSelection);
    updateTableStructure({ rows: nextRows, rowIds: nextRowIds });
    focusTableCell(nextSelection.row, nextSelection.column);
  };
  const addTableColumn = (after = selectedCell.column) => {
    if (rows.length === 0) return;
    const insertion = Math.min(rows[0]!.length, Math.max(0, after + 1));
    const nextRows = rows.map((row) => {
      const next = [...row];
      next.splice(insertion, 0, "");
      return next;
    });
    const nextColumnIds = [...columnIds];
    const nextAlignments = [...columnAlignments];
    nextColumnIds.splice(insertion, 0, nextGeneratedId("table-column"));
    nextAlignments.splice(insertion, 0, "left");
    setSelectedCell({ row: selectedCell.row, column: insertion });
    updateTableStructure({
      rows: nextRows,
      columnIds: nextColumnIds,
      columnAlignments: nextAlignments,
    });
    focusTableCell(selectedCell.row, insertion);
  };
  const removeTableColumn = () => {
    const width = rows[0]?.length ?? 0;
    if (width <= 1) return;
    const column = Math.min(selectedCell.column, width - 1);
    const nextRows = rows.map((row) => row.filter((_, index) => index !== column));
    const nextColumnIds = columnIds.filter((_, index) => index !== column);
    const nextAlignments = columnAlignments.filter((_, index) => index !== column);
    const nextSelection = { row: selectedCell.row, column: Math.min(column, width - 2) };
    setSelectedCell(nextSelection);
    updateTableStructure({
      rows: nextRows,
      columnIds: nextColumnIds,
      columnAlignments: nextAlignments,
    });
    focusTableCell(nextSelection.row, nextSelection.column);
  };
  const moveTableRow = (direction: -1 | 1) => {
    const from = selectedCell.row;
    const to = from + direction;
    if (to < 0 || to >= rows.length) return;
    const nextRows = rows.map((row) => [...row]);
    const nextRowIds = [...rowIds];
    [nextRows[from], nextRows[to]] = [nextRows[to]!, nextRows[from]!];
    [nextRowIds[from], nextRowIds[to]] = [nextRowIds[to]!, nextRowIds[from]!];
    setSelectedCell({ row: to, column: selectedCell.column });
    updateTableStructure({ rows: nextRows, rowIds: nextRowIds });
    focusTableCell(to, selectedCell.column);
  };
  const moveTableColumn = (direction: -1 | 1) => {
    const from = selectedCell.column;
    const to = from + direction;
    const width = rows[0]?.length ?? 0;
    if (to < 0 || to >= width) return;
    const nextRows = rows.map((row) => {
      const next = [...row];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    });
    const nextColumnIds = [...columnIds];
    const nextAlignments = [...columnAlignments];
    [nextColumnIds[from], nextColumnIds[to]] = [nextColumnIds[to]!, nextColumnIds[from]!];
    const movedAlignment = nextAlignments[from]!;
    nextAlignments[from] = nextAlignments[to]!;
    nextAlignments[to] = movedAlignment;
    setSelectedCell({ row: selectedCell.row, column: to });
    updateTableStructure({
      rows: nextRows,
      columnIds: nextColumnIds,
      columnAlignments: nextAlignments,
    });
    focusTableCell(selectedCell.row, to);
  };
  if (kind === "title") {
    const authorEnabled = node.attrs.authorEnabled === true;
    const showAuthor = authorEnabled || addingAuthor;
    const dateEnabled = node.attrs.dateEnabled !== false;
    return (
      <NodeViewWrapper
        className="scient-latex-title-preview"
        data-selected={selected || undefined}
        contentEditable={false}
        onFocusCapture={() => setObjectActive(true)}
        onBlurCapture={(event: FocusEvent<HTMLElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null))
            setObjectActive(false);
        }}
      >
        <input
          aria-label="Document title"
          disabled={!editorEditable}
          placeholder="Document title"
          value={String(node.attrs.title ?? "")}
          onChange={(event) => updateAttributes({ title: event.currentTarget.value })}
        />
        {showAuthor ? (
          <input
            autoFocus={addingAuthor}
            aria-label="Document author"
            disabled={!editorEditable}
            placeholder="Author"
            value={String(node.attrs.author ?? "")}
            onBlur={(event) => {
              if (!event.currentTarget.value) setAddingAuthor(false);
            }}
            onChange={(event) => {
              const author = event.currentTarget.value;
              if (!author) {
                setAddingAuthor(false);
                updateAttributes({ author: "", authorEnabled: false });
                return;
              }
              setAddingAuthor(false);
              updateAttributes({ author, authorEnabled: true });
            }}
          />
        ) : null}
        {dateEnabled ? (
          <input
            aria-label="Document date"
            disabled={!editorEditable}
            placeholder="Date"
            value={String(node.attrs.date ?? "")}
            onChange={(event) =>
              updateAttributes({ date: event.currentTarget.value, dateMode: "explicit" })
            }
          />
        ) : null}
        {controlsVisible ? (
          <div className="scient-latex-title-controls" role="toolbar" aria-label="Title details">
            <button
              disabled={!editorEditable}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (authorEnabled) updateAttributes({ author: "", authorEnabled: false });
                else setAddingAuthor((adding) => !adding);
              }}
              type="button"
            >
              {authorEnabled ? "Remove author" : addingAuthor ? "Cancel author" : "Add author"}
            </button>
            <button
              disabled={!editorEditable}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                updateAttributes(
                  dateEnabled
                    ? { date: "", dateEnabled: false, dateMode: "hidden" }
                    : { date: visualTodayLabel(), dateEnabled: true, dateMode: "today" },
                )
              }
              type="button"
            >
              {dateEnabled ? "Hide date" : "Add date"}
            </button>
          </div>
        ) : null}
      </NodeViewWrapper>
    );
  }
  if (kind === "abstract") {
    return (
      <NodeViewWrapper
        className="scient-latex-abstract-preview"
        data-selected={selected || undefined}
        contentEditable={false}
      >
        <h2>Abstract</h2>
        <textarea
          aria-label="Abstract"
          disabled={!editorEditable || !structureEditable}
          rows={4}
          value={String(node.attrs.body ?? "")}
          onChange={(event) => updateAttributes({ body: event.currentTarget.value })}
        />
      </NodeViewWrapper>
    );
  }
  if (kind === "toc") {
    const entries = Array.isArray(node.attrs.tocEntries)
      ? (node.attrs.tocEntries as { level?: unknown; number?: unknown; title?: unknown }[])
      : [];
    return (
      <NodeViewWrapper className="scient-latex-toc-preview" contentEditable={false}>
        <h2>Contents</h2>
        {entries.length > 0 ? (
          <ol>
            {entries.map((entry) => (
              <li data-level={Number(entry.level ?? 1)} key={String(entry.number)}>
                <span>{String(entry.number ?? "")}</span>
                <span>{String(entry.title ?? "")}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p>The table of contents will be generated from numbered headings.</p>
        )}
      </NodeViewWrapper>
    );
  }
  if (kind === "pagebreak") {
    const command =
      String(node.attrs.raw ?? "").trim() === "\\clearpage" ? "\\clearpage" : "\\newpage";
    return (
      <NodeViewWrapper
        aria-label={`${command} page break`}
        className="scient-latex-page-break"
        contentEditable={false}
      />
    );
  }
  if (kind === "figure") {
    const figureEditable = structureEditable && editorEditable;
    return (
      <NodeViewWrapper
        className="scient-latex-rich-preview scient-latex-figure-preview"
        data-selected={selected || undefined}
        contentEditable={false}
      >
        <div className="scient-latex-rich-preview-label">
          <span>Figure</span>
          <span>{structureEditable ? "Editable LaTeX figure" : "Protected source"}</span>
        </div>
        <div className="scient-latex-object-toolbar" role="toolbar" aria-label="Figure tools">
          <label>
            Alignment
            <select
              aria-label="Figure alignment"
              disabled={!figureEditable}
              value={String(node.attrs.figureAlignment ?? "center")}
              onChange={(event) => updateAttributes({ figureAlignment: event.currentTarget.value })}
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label>
            Placement
            <input
              aria-label="Figure placement"
              disabled={!figureEditable}
              value={String(node.attrs.figurePlacement ?? "")}
              onChange={(event) => updateAttributes({ figurePlacement: event.currentTarget.value })}
            />
          </label>
          <label>
            Width
            <input
              aria-label="Figure width"
              disabled={!figureEditable}
              value={String(node.attrs.figureWidth ?? "")}
              onChange={(event) => updateAttributes({ figureWidth: event.currentTarget.value })}
            />
          </label>
          <button disabled={!figureEditable} onClick={deleteNode} type="button">
            Delete figure
          </button>
        </div>
        <figure data-align={String(node.attrs.figureAlignment ?? "center")}>
          <LatexFigureImage
            alt={String(node.attrs.caption ?? "")}
            path={String(node.attrs.path ?? "")}
            width={String(node.attrs.figureWidth ?? "")}
            workspace={workspace}
          />
          <label className="scient-latex-object-field">
            Image path
            <input
              aria-label="Figure image path"
              disabled={!figureEditable}
              value={String(node.attrs.path ?? "")}
              onChange={(event) => updateAttributes({ path: event.currentTarget.value })}
            />
          </label>
          <figcaption>
            <input
              aria-label="Figure caption"
              disabled={!figureEditable}
              placeholder="Add a figure caption"
              value={String(node.attrs.caption ?? "")}
              onChange={(event) => updateAttributes({ caption: event.currentTarget.value })}
            />
          </figcaption>
          <label className="scient-latex-table-label">
            Reference label
            <input
              aria-label="Figure reference label"
              disabled={!figureEditable}
              placeholder="fig:result"
              value={String(node.attrs.label ?? "")}
              onChange={(event) => updateAttributes({ label: event.currentTarget.value })}
            />
          </label>
        </figure>
      </NodeViewWrapper>
    );
  }
  if (kind === "scientific") {
    const scientificEditable = structureEditable && editorEditable;
    return (
      <NodeViewWrapper
        className="scient-latex-rich-preview scient-latex-scientific-preview"
        data-environment={String(node.attrs.environment ?? "theorem")}
        data-selected={selected || undefined}
        contentEditable={false}
      >
        <div className="scient-latex-rich-preview-label">
          <span>Scientific statement</span>
          <button disabled={!scientificEditable} onClick={deleteNode} type="button">
            Delete
          </button>
        </div>
        <div className="scient-latex-scientific-heading">
          <select
            aria-label="Scientific statement type"
            disabled={!scientificEditable}
            value={String(node.attrs.environment ?? "theorem")}
            onChange={(event) => updateAttributes({ environment: event.currentTarget.value })}
          >
            {[
              "theorem",
              "lemma",
              "proposition",
              "corollary",
              "claim",
              "definition",
              "example",
              "remark",
              "proof",
            ].map((environment) => (
              <option key={environment} value={environment}>
                {environment[0]!.toUpperCase() + environment.slice(1)}
              </option>
            ))}
          </select>
          <input
            aria-label="Scientific statement title"
            disabled={!scientificEditable}
            placeholder="Optional title"
            value={String(node.attrs.title ?? "")}
            onChange={(event) => updateAttributes({ title: event.currentTarget.value })}
          />
        </div>
        <textarea
          aria-label="Scientific statement body"
          disabled={!scientificEditable}
          rows={4}
          value={String(node.attrs.body ?? "")}
          onChange={(event) => updateAttributes({ body: event.currentTarget.value })}
        />
        <label className="scient-latex-object-field">
          Reference label
          <input
            aria-label="Scientific statement reference label"
            disabled={!scientificEditable}
            placeholder="thm:main"
            value={String(node.attrs.label ?? "")}
            onChange={(event) => updateAttributes({ label: event.currentTarget.value })}
          />
        </label>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper
      className="scient-latex-rich-preview"
      data-kind={kind}
      data-description-style={
        kind === "description" ? String(node.attrs.descriptionStyle ?? "standard") : undefined
      }
      data-selected={selected || undefined}
      contentEditable={false}
      style={
        kind === "description" && typeof node.attrs.descriptionLeftMargin === "string"
          ? ({
              "--scient-description-left-margin": node.attrs.descriptionLeftMargin,
            } as CSSProperties)
          : undefined
      }
      onFocusCapture={() => setObjectActive(true)}
      onBlurCapture={(event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null))
          setObjectActive(false);
      }}
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
                      rows={1}
                      value={String(item.body ?? "")}
                      onChange={(event) =>
                        updateDescriptionItem(index, "body", event.currentTarget.value)
                      }
                    />
                  ) : (
                    String(item.body ?? "")
                  )}
                </dd>
                {descriptionEditable && controlsVisible ? (
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
          {descriptionEditable && controlsVisible ? (
            <div className="scient-latex-structure-actions">
              <button disabled={!editorEditable} onClick={addDescriptionItem} type="button">
                Add item
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <figure ref={tableRoot} data-table-style={String(node.attrs.tableStyle ?? "plain")}>
          {tableEditable && controlsVisible ? (
            <div className="scient-latex-table-toolbar" role="toolbar" aria-label="Table tools">
              <label>
                Style
                <select
                  aria-label="Table style"
                  disabled={!editorEditable}
                  value={String(node.attrs.tableStyle ?? "plain")}
                  onChange={(event) => updateTableStructure({ tableStyle: event.target.value })}
                >
                  <option value="plain">Simple</option>
                  <option value="booktabs">Booktabs</option>
                  <option value="grid">Full grid</option>
                </select>
              </label>
              <label>
                Width
                <select
                  aria-label="Table width behavior"
                  disabled={!editorEditable || node.attrs.tableKind === "long"}
                  value={String(node.attrs.tableKind ?? "fixed")}
                  onChange={(event) => updateTableStructure({ tableKind: event.target.value })}
                >
                  <option value="fixed">Fit content</option>
                  <option value="stretch">Fit page</option>
                  {node.attrs.tableKind === "long" ? <option value="long">Multipage</option> : null}
                </select>
              </label>
              <button
                aria-pressed={node.attrs.hasHeader === true}
                disabled={!editorEditable}
                onClick={() => updateTableStructure({ hasHeader: node.attrs.hasHeader !== true })}
                type="button"
              >
                Header row
              </button>
              <span className="scient-latex-table-toolbar-separator" />
              <button
                aria-label="Move selected row up"
                disabled={!editorEditable || selectedCell.row === 0}
                onClick={() => moveTableRow(-1)}
                type="button"
              >
                Row ↑
              </button>
              <button
                aria-label="Move selected row down"
                disabled={!editorEditable || selectedCell.row >= rows.length - 1}
                onClick={() => moveTableRow(1)}
                type="button"
              >
                Row ↓
              </button>
              <button disabled={!editorEditable} onClick={() => addTableRow()} type="button">
                + Row
              </button>
              <button
                disabled={!editorEditable || rows.length <= 1}
                onClick={removeTableRow}
                type="button"
              >
                − Row
              </button>
              <span className="scient-latex-table-toolbar-separator" />
              <button
                aria-label="Move selected column left"
                disabled={!editorEditable || selectedCell.column === 0}
                onClick={() => moveTableColumn(-1)}
                type="button"
              >
                Col ←
              </button>
              <button
                aria-label="Move selected column right"
                disabled={!editorEditable || selectedCell.column >= (rows[0]?.length ?? 1) - 1}
                onClick={() => moveTableColumn(1)}
                type="button"
              >
                Col →
              </button>
              <button disabled={!editorEditable} onClick={() => addTableColumn()} type="button">
                + Column
              </button>
              <button
                disabled={!editorEditable || (rows[0]?.length ?? 0) <= 1}
                onClick={removeTableColumn}
                type="button"
              >
                − Column
              </button>
              <label>
                Align
                <select
                  aria-label="Selected column alignment"
                  disabled={!editorEditable}
                  value={columnAlignments[selectedCell.column] ?? "left"}
                  onChange={(event) => {
                    const next = [...columnAlignments];
                    next[selectedCell.column] = event.target
                      .value as (typeof columnAlignments)[number];
                    updateTableStructure({ columnAlignments: next });
                  }}
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </label>
            </div>
          ) : null}
          <figcaption>
            {captionEditable ? (
              <input
                aria-label="Table caption"
                disabled={!editorEditable}
                placeholder="Add a table caption"
                value={caption}
                onChange={(event) => {
                  const nextCaption = event.currentTarget.value;
                  if (sourceMeta?.captionRange === null)
                    updateTableStructure({ caption: nextCaption });
                  else updateAttributes({ caption: nextCaption });
                }}
              />
            ) : (
              caption || "Table"
            )}
          </figcaption>
          {labelEditable && controlsVisible ? (
            <label className="scient-latex-table-label">
              Reference label
              <input
                aria-label="Table reference label"
                disabled={!editorEditable}
                placeholder="tab:results"
                value={tableLabel}
                onChange={(event) => {
                  const nextLabel = event.currentTarget.value;
                  if (sourceMeta?.labelRange === null) updateTableStructure({ label: nextLabel });
                  else updateAttributes({ label: nextLabel });
                }}
              />
            </label>
          ) : null}
          <div className="scient-latex-rich-table-scroll">
            <table>
              {tableEditable && controlsVisible ? (
                <thead aria-label="Column controls">
                  <tr>
                    <th className="scient-latex-table-corner" />
                    {rows[0]?.map((_, columnIndex) => (
                      <th
                        className="scient-latex-table-column-handle"
                        data-selected={selectedCell.column === columnIndex || undefined}
                        key={columnIds[columnIndex] ?? `column-${columnIndex}`}
                      >
                        <button
                          aria-label={`Select table column ${columnIndex + 1}`}
                          onClick={() =>
                            setSelectedCell({ row: selectedCell.row, column: columnIndex })
                          }
                          type="button"
                        >
                          {columnIndex + 1}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
              ) : null}
              <tbody>
                {keyedRows.map(({ index: rowIndex, key, value: row }) => (
                  <tr key={key}>
                    {tableEditable && controlsVisible ? (
                      <th
                        className="scient-latex-table-row-handle"
                        data-selected={selectedCell.row === rowIndex || undefined}
                        scope="row"
                      >
                        <button
                          aria-label={`Select table row ${rowIndex + 1}`}
                          onClick={() =>
                            setSelectedCell({ row: rowIndex, column: selectedCell.column })
                          }
                          type="button"
                        >
                          {rowIndex + 1}
                        </button>
                      </th>
                    ) : null}
                    {(tableEditable
                      ? row.map((cell, index) => ({
                          index,
                          key: `${rowIds[rowIndex] ?? rowIndex}-${index}`,
                          value: cell,
                        }))
                      : withStableKeys(row, String)
                    ).map(({ index: cellIndex, key: cellKey, value: cell }) => {
                      const content = tableEditable ? (
                        <textarea
                          aria-label={`Table row ${rowIndex + 1} column ${cellIndex + 1}`}
                          data-table-cell={`${rowIndex}-${cellIndex}`}
                          disabled={!editorEditable}
                          rows={1}
                          value={cell}
                          onFocus={() => setSelectedCell({ row: rowIndex, column: cellIndex })}
                          onChange={(event) =>
                            updateCell(rowIndex, cellIndex, event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape") event.currentTarget.blur();
                            if (event.key !== "Tab") return;
                            const width = row.length;
                            const current = rowIndex * width + cellIndex;
                            const next = current + (event.shiftKey ? -1 : 1);
                            if (next < 0) return;
                            event.preventDefault();
                            if (next >= rows.length * width) {
                              addTableRow(rows.length - 1);
                              return;
                            }
                            const nextCell = {
                              row: Math.floor(next / width),
                              column: next % width,
                            };
                            setSelectedCell(nextCell);
                            focusTableCell(nextCell.row, nextCell.column);
                          }}
                        />
                      ) : (
                        cell
                      );
                      return node.attrs.hasHeader === true && rowIndex === 0 ? (
                        <th
                          data-align={columnAlignments[cellIndex] ?? "left"}
                          data-selected={
                            controlsVisible &&
                            selectedCell.row === rowIndex &&
                            selectedCell.column === cellIndex
                              ? true
                              : undefined
                          }
                          key={cellKey}
                          scope="col"
                        >
                          {content}
                        </th>
                      ) : (
                        <td
                          data-align={columnAlignments[cellIndex] ?? "left"}
                          data-selected={
                            controlsVisible &&
                            selectedCell.row === rowIndex &&
                            selectedCell.column === cellIndex
                              ? true
                              : undefined
                          }
                          key={cellKey}
                        >
                          {content}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tableEditable && controlsVisible ? (
            <div className="scient-latex-table-hint">
              Tab moves between cells; Tab in the last cell adds a row. Structure controls normalize
              only this supported table.
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

const LatexRichPreview = Node.create<LatexVisualWorkspace>({
  name: "latexRichPreview",
  group: "block",
  atom: true,
  selectable: true,
  addOptions() {
    return { environmentId: null, cwd: null, relativePath: null };
  },
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
      columnIds: { default: null, rendered: false },
      columnAlignments: { default: null },
      tableStyle: { default: "plain" },
      tableKind: { default: "fixed" },
      hasHeader: { default: false },
      tableCanonical: { default: false, rendered: false },
      editable: { default: false, rendered: false },
      caption: { default: null },
      label: { default: null },
      environment: { default: null },
      title: { default: null },
      author: { default: null },
      date: { default: null },
      authorEnabled: { default: false },
      dateEnabled: { default: true },
      dateMode: { default: "default" },
      tocEntries: { default: null, rendered: false },
      descriptionStyle: { default: "standard" },
      descriptionLeftMargin: { default: null },
      body: { default: null },
      path: { default: null },
      figureWidth: { default: null },
      figureOptions: { default: null, rendered: false },
      figurePlacement: { default: null },
      figureAlignment: { default: null },
      figureStarred: { default: false },
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
    const workspace = this.options;
    return ReactNodeViewRenderer((props) => (
      <LatexRichPreviewView {...props} workspace={workspace} />
    ));
  },
});

const baseExtensions = [
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

const DOCUMENT_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export interface LatexVisualEditorProps {
  readonly draftKey: string;
  readonly fileRevision: string;
  readonly source: string;
  readonly disabled: boolean;
  readonly onEdit: (expected: string, next: string) => boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly onOpenSource: () => void;
  readonly environmentId?: EnvironmentId | undefined;
  readonly cwd?: string | undefined;
  readonly relativePath?: string | undefined;
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
  const [editorRevision, refreshToolbar] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeRibbon, setActiveRibbon] = useState<"home" | "insert" | "references" | "layout">(
    "home",
  );
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [tablePreset, setTablePreset] = useState<LatexVisualTablePreset>("booktabs");
  const [tablePickerSize, setTablePickerSize] = useState({ rows: 3, columns: 3 });
  const [referenceCommand, setReferenceCommand] = useState("ref");
  const [referenceTarget, setReferenceTarget] = useState("");
  const [layoutDraft, setLayoutDraft] = useState(() => {
    const profile = latexVisualLayoutProfile(props.source);
    return {
      paper: profile.paper,
      baseFontPt: profile.baseFontPt,
      margin: `${Math.round(profile.marginTopIn * 100) / 100}in`,
      paragraphStyle: profile.paragraphGapEm > 0 ? ("spaced" as const) : ("indented" as const),
    };
  });
  const tablePicker = useRef<HTMLDetailsElement | null>(null);
  const [summary, setSummary] = useState({
    supported: initial.supportedBlocks,
    raw: initial.rawBlocks,
  });
  const [pageCount, setPageCount] = useState(1);
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [fitZoom, setFitZoom] = useState(1);
  const visualScroll = useRef<HTMLDivElement | null>(null);

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

  const richPreviewExtension = useMemo(
    () =>
      LatexRichPreview.configure({
        environmentId: props.environmentId ?? null,
        cwd: props.cwd ?? null,
        relativePath: props.relativePath ?? null,
      }),
    [props.cwd, props.environmentId, props.relativePath],
  );

  const guardedExtensions = useMemo(
    () => [
      ...baseExtensions,
      richPreviewExtension,
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
    [richPreviewExtension],
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

  const insertVisualSource = (source: string) => {
    const node = projectLatexVisualDocument(source).content.content?.[0];
    if (node) editor?.chain().focus().insertContent(node).run();
  };

  const insertTable = (rows: number, columns: number) => {
    const source = latexVisualTableSource(rows, columns, tablePreset);
    const table = projectLatexVisualDocument(source).content.content?.[0];
    if (!table) return;
    editor?.chain().focus().insertContent(table).run();
    if (tablePicker.current) tablePicker.current.open = false;
  };
  const labels = [
    ...new Set([...props.source.matchAll(/\\label\{([^{}]+)\}/gu)].map((match) => match[1]!)),
  ];
  const layout = latexVisualLayoutProfile(props.source);
  void editorRevision;
  const outline: { level: number; position: number; title: string }[] = [];
  editor?.state.doc.descendants((node, position) => {
    if (node.type.name !== "heading") return;
    outline.push({
      level: Number(node.attrs.level ?? 1),
      position,
      title: node.textContent.trim() || "Untitled heading",
    });
  });
  const selectionContext = (() => {
    if (!editor) return "Document";
    const selection = editor.state.selection as typeof editor.state.selection & {
      readonly node?: ProseMirrorNode;
    };
    const node = selection.node ?? selection.$from.parent;
    if (node.type.name === "latexInlineMath" || node.type.name === "latexDisplayMath")
      return "Equation";
    if (node.type.name === "latexRichPreview") {
      const kind = String(node.attrs.kind ?? "object");
      return kind === "scientific"
        ? String(node.attrs.environment ?? "Statement")
        : kind[0]!.toUpperCase() + kind.slice(1);
    }
    if (node.type.name === "heading") return `Heading ${String(node.attrs.level ?? 1)}`;
    if (node.type.name === "bulletList" || node.type.name === "orderedList") return "List";
    return "Body text";
  })();
  const pageHeight = layout.paper === "a4" ? 1123 : 1056;
  const pageGap = 32;
  const paperStyle = {
    "--scient-latex-paper-width": layout.paper === "a4" ? "794px" : "816px",
    "--scient-latex-paper-height": `${pageHeight}px`,
    "--scient-latex-page-gap": `${pageGap}px`,
    "--scient-latex-margin-top": `${layout.marginTopIn}in`,
    "--scient-latex-margin-right": `${layout.marginRightIn}in`,
    "--scient-latex-margin-bottom": `${layout.marginBottomIn}in`,
    "--scient-latex-margin-left": `${layout.marginLeftIn}in`,
    "--scient-latex-font-size": `${layout.baseFontPt}pt`,
    "--scient-latex-line-height": String(layout.lineHeight),
    "--scient-latex-par-indent": `${layout.paragraphIndentEm}em`,
    "--scient-latex-par-gap": `${layout.paragraphGapEm}em`,
  } as CSSProperties;

  useLayoutEffect(() => {
    if (!editor) return;
    const root = editor.view.dom as HTMLElement;
    let frame = 0;
    let paginating = false;
    let observer: ResizeObserver | null = null;
    const marginTop = layout.marginTopIn * 96;
    const marginBottom = layout.marginBottomIn * 96;

    const restoreNaturalLayout = (child: HTMLElement) => {
      const original = child.dataset.latexPaginationMarginTop;
      if (original === undefined) {
        child.dataset.latexPaginationMarginTop = child.style.marginTop || "__unset__";
      } else if (original === "__unset__") {
        child.style.removeProperty("margin-top");
      } else {
        child.style.marginTop = original;
      }
      child.style.removeProperty("--scient-latex-page-break-space");
      child.style.removeProperty("--scient-latex-page-break-marker");
      child.removeAttribute("data-latex-page");
    };

    const topWithinEditor = (element: HTMLElement) => {
      const documentTop = (target: HTMLElement) => {
        let top = 0;
        let current: HTMLElement | null = target;
        while (current) {
          top += current.offsetTop;
          current = current.offsetParent as HTMLElement | null;
        }
        return top;
      };
      return documentTop(element) - documentTop(root);
    };

    const paginationUnits = () =>
      [...root.children].flatMap((node) => {
        if (!(node instanceof HTMLElement)) return [];
        if (node.classList.contains("scient-latex-toc-preview")) {
          const heading = node.querySelector<HTMLElement>(":scope > h2");
          const entries = [...node.querySelectorAll<HTMLElement>(":scope > ol > li")];
          if (!heading || entries.length === 0) return [{ element: node, bottomElement: node }];
          return [
            { element: heading, bottomElement: entries[0]! },
            ...entries.slice(1).map((element) => ({ element, bottomElement: element })),
          ];
        }
        if (node.matches('.scient-latex-rich-preview[data-kind="description"]')) {
          const items = [...node.querySelectorAll<HTMLElement>(":scope > dl > div")];
          if (items.length > 0)
            return items.map((element) => ({ element, bottomElement: element }));
        }
        if (node.matches("ul, ol")) {
          const items = [...node.querySelectorAll<HTMLElement>(":scope > li")];
          if (items.length > 0)
            return items.map((element) => ({ element, bottomElement: element }));
        }
        return [{ element: node, bottomElement: node }];
      });

    const paginate = () => {
      if (paginating) return;
      paginating = true;
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-latex-pagination-margin-top]",
      ))
        restoreNaturalLayout(element);
      const units = paginationUnits();
      for (const unit of units) restoreNaturalLayout(unit.element);
      const naturalMargins = units.map(
        ({ element }) => Number.parseFloat(getComputedStyle(element).marginTop) || 0,
      );
      const blocks = units.map(({ element, bottomElement }) => ({
        top: topWithinEditor(element),
        bottom: topWithinEditor(bottomElement) + bottomElement.offsetHeight,
        explicitBreak: element.classList.contains("scient-latex-page-break"),
      }));
      const plan = planLatexVisualPagination(blocks, {
        pageHeight,
        pageGap,
        marginTop,
        marginBottom,
      });
      plan.placements.forEach((placement, index) => {
        const child = units[index]?.element;
        if (!child) return;
        child.dataset.latexPage = String(placement.page + 1);
        if (child.classList.contains("scient-latex-page-break")) {
          child.style.setProperty("--scient-latex-page-break-space", `${placement.offset}px`);
          child.style.setProperty(
            "--scient-latex-page-break-marker",
            `${placement.markerOffset ?? 0}px`,
          );
        } else if (placement.offset > 0) {
          child.style.marginTop = `${naturalMargins[index]! + placement.offset}px`;
        }
        observer?.observe(child);
      });
      root.style.setProperty(
        "--scient-latex-document-height",
        `${plan.pageCount * pageHeight + (plan.pageCount - 1) * pageGap}px`,
      );
      setPageCount((current) => (current === plan.pageCount ? current : plan.pageCount));
      paginating = false;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paginate);
    };
    observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(root);
    editor.on("update", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      editor.off("update", schedule);
      for (const child of root.querySelectorAll<HTMLElement>(
        "[data-latex-pagination-margin-top]",
      )) {
        restoreNaturalLayout(child);
        delete child.dataset.latexPaginationMarginTop;
      }
    };
  }, [editor, layout.marginBottomIn, layout.marginTopIn, pageHeight]);

  useLayoutEffect(() => {
    const scroll = visualScroll.current;
    if (!scroll) return;
    const updateFitZoom = () => {
      const available = Math.max(1, scroll.clientWidth - 96);
      setFitZoom(Math.min(2, Math.max(0.35, available / (layout.paper === "a4" ? 794 : 816))));
    };
    updateFitZoom();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFitZoom);
    observer?.observe(scroll);
    return () => observer?.disconnect();
  }, [layout.paper]);

  const zoom = zoomMode === "fit" ? fitZoom : zoomMode;
  const paperWidth = layout.paper === "a4" ? 794 : 816;
  const pageStackHeight = pageCount * pageHeight + (pageCount - 1) * pageGap;
  const stageHeight = 25 + pageStackHeight;
  const changeZoom = (direction: -1 | 1) => {
    const current = zoom;
    const levels = direction > 0 ? DOCUMENT_ZOOM_LEVELS : DOCUMENT_ZOOM_LEVELS.toReversed();
    const next = levels.find((level) =>
      direction > 0 ? level > current + 0.01 : level < current - 0.01,
    );
    if (next !== undefined) setZoomMode(next);
  };

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
      <div className="scient-latex-writing-header">
        <div>
          <strong>Writing canvas</strong>
          <span>Source-backed LaTeX document</span>
        </div>
        <div className="scient-latex-writing-header-actions">
          <div className="scient-latex-zoom-controls" role="group" aria-label="Document zoom">
            <button aria-label="Zoom out" onClick={() => changeZoom(-1)} type="button">
              −
            </button>
            <select
              aria-label="Document zoom level"
              value={zoomMode}
              onChange={(event) =>
                setZoomMode(
                  event.currentTarget.value === "fit" ? "fit" : Number(event.currentTarget.value),
                )
              }
            >
              <option value="fit">Fit</option>
              {DOCUMENT_ZOOM_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {Math.round(level * 100)}%
                </option>
              ))}
            </select>
            <button aria-label="Zoom in" onClick={() => changeZoom(1)} type="button">
              +
            </button>
          </div>
          <button
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen((value) => !value)}
            type="button"
          >
            {navigationOpen ? "Hide navigation" : "Show navigation"}
          </button>
          <button className="scient-latex-source-button" type="button" onClick={props.onOpenSource}>
            Edit LaTeX
          </button>
        </div>
      </div>
      <div className="scient-latex-ribbon-tabs" role="tablist" aria-label="Writing tools">
        {(["home", "insert", "references", "layout"] as const).map((section) => (
          <button
            aria-selected={activeRibbon === section}
            key={section}
            onClick={() => setActiveRibbon(section)}
            role="tab"
            type="button"
          >
            {section[0]!.toUpperCase() + section.slice(1)}
          </button>
        ))}
      </div>
      <div
        className="scient-latex-writing-toolbar"
        data-ribbon={activeRibbon}
        role="toolbar"
        aria-label="Document formatting"
      >
        <div
          className="scient-latex-toolbar-group"
          aria-label="Text style"
          hidden={activeRibbon !== "home"}
        >
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
        <div
          className="scient-latex-toolbar-group"
          aria-label="Insert mathematics"
          hidden={activeRibbon !== "insert"}
        >
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
        <div
          className="scient-latex-toolbar-group"
          aria-label="Insert table"
          hidden={activeRibbon !== "insert"}
        >
          <details
            className="scient-latex-table-picker"
            onToggle={(event) => {
              if (readOnly) event.currentTarget.open = false;
            }}
            ref={tablePicker}
          >
            <summary aria-disabled={readOnly} aria-label="Insert table">
              Table
            </summary>
            <div className="scient-latex-table-picker-popover">
              <label>
                Table style
                <select
                  aria-label="New table style"
                  disabled={readOnly}
                  value={tablePreset}
                  onChange={(event) =>
                    setTablePreset(event.currentTarget.value as LatexVisualTablePreset)
                  }
                >
                  <option value="plain">Simple</option>
                  <option value="booktabs">Booktabs</option>
                  <option value="grid">Full grid</option>
                  <option value="stretch">Fit page</option>
                </select>
              </label>
              <div className="scient-latex-table-picker-size">
                {tablePickerSize.rows} × {tablePickerSize.columns}
              </div>
              <div className="scient-latex-table-picker-grid">
                {Array.from({ length: 25 }, (_, index) => {
                  const row = Math.floor(index / 5) + 1;
                  const column = (index % 5) + 1;
                  const active = row <= tablePickerSize.rows && column <= tablePickerSize.columns;
                  return (
                    <button
                      aria-label={`Insert ${row} by ${column} table`}
                      data-active={active || undefined}
                      disabled={readOnly}
                      key={`${row}-${column}`}
                      onClick={() => insertTable(row, column)}
                      onMouseEnter={() => setTablePickerSize({ rows: row, columns: column })}
                      type="button"
                    />
                  );
                })}
              </div>
            </div>
          </details>
        </div>
        <div
          className="scient-latex-toolbar-group"
          aria-label="Insert scientific object"
          hidden={activeRibbon !== "insert"}
        >
          <select
            aria-label="Insert scientific statement"
            disabled={readOnly}
            value=""
            onChange={(event) => {
              const source = latexVisualScientificSource(event.currentTarget.value);
              if (source) insertVisualSource(source);
              event.currentTarget.value = "";
            }}
          >
            <option value="">Statement…</option>
            <option value="theorem">Theorem</option>
            <option value="claim">Claim</option>
            <option value="lemma">Lemma</option>
            <option value="proposition">Proposition</option>
            <option value="corollary">Corollary</option>
            <option value="definition">Definition</option>
            <option value="example">Example</option>
            <option value="remark">Remark</option>
            <option value="proof">Proof</option>
          </select>
          <button
            disabled={readOnly}
            onClick={() => insertVisualSource(latexVisualFigureSource())}
            type="button"
          >
            Figure
          </button>
          <button disabled={readOnly} onClick={() => insertVisualSource("\\newpage")} type="button">
            Page break
          </button>
        </div>
        <div
          className="scient-latex-toolbar-group"
          aria-label="Insert reference"
          hidden={activeRibbon !== "references"}
        >
          <select
            aria-label="Reference command"
            disabled={readOnly}
            value={referenceCommand}
            onChange={(event) => setReferenceCommand(event.currentTarget.value)}
          >
            <option value="ref">Reference</option>
            <option value="eqref">Equation reference</option>
            <option value="autoref">Automatic reference</option>
            <option value="pageref">Page reference</option>
            <option value="cite">Citation</option>
            <option value="citet">Text citation</option>
            <option value="citep">Parenthetical citation</option>
          </select>
          <input
            aria-label="Reference or citation key"
            disabled={readOnly}
            list="scient-latex-labels"
            placeholder="label or citation key"
            value={referenceTarget}
            onChange={(event) => setReferenceTarget(event.currentTarget.value)}
          />
          <datalist id="scient-latex-labels">
            {labels.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          <button
            disabled={readOnly || !referenceTarget || /[{}\\%]/u.test(referenceTarget)}
            onClick={() => {
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "latexInlineCommand",
                  attrs: {
                    name: referenceCommand,
                    argument: referenceTarget,
                    raw: `\\${referenceCommand}{${referenceTarget}}`,
                  },
                })
                .run();
              setReferenceTarget("");
            }}
            type="button"
          >
            Insert
          </button>
        </div>
        <div
          className="scient-latex-toolbar-group"
          aria-label="Document layout"
          hidden={activeRibbon !== "layout"}
        >
          <details
            className="scient-latex-layout-picker"
            onToggle={(event) => {
              if (readOnly) {
                event.currentTarget.open = false;
                return;
              }
              if (!event.currentTarget.open) return;
              const profile = latexVisualLayoutProfile(props.source);
              setLayoutDraft({
                paper: profile.paper,
                baseFontPt: profile.baseFontPt,
                margin: `${Math.round(profile.marginTopIn * 100) / 100}in`,
                paragraphStyle: profile.paragraphGapEm > 0 ? "spaced" : "indented",
              });
            }}
          >
            <summary aria-disabled={readOnly}>Layout</summary>
            <div className="scient-latex-layout-popover">
              <label>
                Paper
                <select
                  disabled={readOnly}
                  value={layoutDraft.paper}
                  onChange={(event) =>
                    setLayoutDraft((value) => ({
                      ...value,
                      paper: event.currentTarget.value as "a4" | "letter",
                    }))
                  }
                >
                  <option value="letter">Letter</option>
                  <option value="a4">A4</option>
                </select>
              </label>
              <label>
                Base font
                <select
                  disabled={readOnly}
                  value={layoutDraft.baseFontPt}
                  onChange={(event) =>
                    setLayoutDraft((value) => ({
                      ...value,
                      baseFontPt: Number(event.currentTarget.value) as 10 | 11 | 12,
                    }))
                  }
                >
                  <option value={10}>10 pt</option>
                  <option value={11}>11 pt</option>
                  <option value={12}>12 pt</option>
                </select>
              </label>
              <label>
                Margins
                <input
                  aria-label="Document margin"
                  disabled={readOnly}
                  value={layoutDraft.margin}
                  onChange={(event) =>
                    setLayoutDraft((value) => ({ ...value, margin: event.currentTarget.value }))
                  }
                />
              </label>
              <label>
                Paragraphs
                <select
                  disabled={readOnly}
                  value={layoutDraft.paragraphStyle}
                  onChange={(event) =>
                    setLayoutDraft((value) => ({
                      ...value,
                      paragraphStyle: event.currentTarget.value as "indented" | "spaced",
                    }))
                  }
                >
                  <option value="indented">First-line indent</option>
                  <option value="spaced">Space between paragraphs</option>
                </select>
              </label>
              <button
                disabled={readOnly}
                onClick={() => {
                  const expected = currentSource.current;
                  const next = updateLatexVisualLayoutSource(expected, layoutDraft);
                  if (next === null) {
                    setNotice("Use a margin such as 1in, 2.5cm, 20mm, or 72pt.");
                    return;
                  }
                  if (!onEdit.current(expected, next)) {
                    setNotice("The source changed elsewhere. Layout was not applied.");
                    return;
                  }
                  currentSource.current = next;
                  installProjection(projectLatexVisualDocument(next), true);
                  setNotice(null);
                }}
                type="button"
              >
                Apply layout
              </button>
              <p>Changes document-class options and explicit preamble lengths.</p>
            </div>
          </details>
        </div>
        <div className="scient-latex-ribbon-description">
          {activeRibbon === "home"
            ? "Write and format the document body"
            : activeRibbon === "insert"
              ? "Add equations, tables, statements and figures"
              : activeRibbon === "references"
                ? "Insert source-backed citations and cross-references"
                : "Change page and paragraph settings in LaTeX"}
        </div>
      </div>
      {notice === null ? null : (
        <div className="scient-latex-visual-notice" role="alert">
          {notice}
        </div>
      )}
      <div className="scient-latex-visual-body" data-navigation={navigationOpen || undefined}>
        {navigationOpen ? (
          <aside className="scient-latex-document-navigation" aria-label="Document navigation">
            <div className="scient-latex-navigation-section">
              <strong>Document</strong>
              <span>{props.relativePath?.split(/[\\/]/u).at(-1) ?? "LaTeX document"}</span>
            </div>
            <nav aria-label="Document outline">
              <div className="scient-latex-navigation-heading">Outline</div>
              {outline.length === 0 ? (
                <p>Add headings to build an outline.</p>
              ) : (
                outline.map((heading) => (
                  <button
                    key={`${heading.position}-${heading.title}`}
                    onClick={() =>
                      editor
                        ?.chain()
                        .focus()
                        .setTextSelection(heading.position + 1)
                        .scrollIntoView()
                        .run()
                    }
                    style={{ "--outline-level": heading.level } as CSSProperties}
                    type="button"
                  >
                    {heading.title}
                  </button>
                ))
              )}
            </nav>
            <div className="scient-latex-navigation-heading">Quick insert</div>
            <div className="scient-latex-quick-insert">
              <button
                disabled={readOnly}
                onClick={() => insertDisplayMath(MATH_INSERTIONS.equation)}
                type="button"
              >
                Equation
              </button>
              <button disabled={readOnly} onClick={() => insertTable(3, 3)} type="button">
                Table
              </button>
              <button
                disabled={readOnly}
                onClick={() => {
                  const source = latexVisualScientificSource("claim");
                  if (source) insertVisualSource(source);
                }}
                type="button"
              >
                Claim
              </button>
              <button
                disabled={readOnly}
                onClick={() => insertVisualSource(latexVisualFigureSource())}
                type="button"
              >
                Figure
              </button>
            </div>
            <details className="scient-latex-writing-help">
              <summary>Editing boundaries</summary>
              <p>
                Text and supported scientific objects edit LaTeX directly. Protected source remains
                lossless. Rebuild verifies packages, macros, numbering, floats and final pagination.
              </p>
            </details>
          </aside>
        ) : null}
        <div className="scient-latex-visual-scroll" ref={visualScroll}>
          <div
            className="scient-latex-page-zoom-frame"
            style={{ width: paperWidth * zoom, height: stageHeight * zoom }}
          >
            <div
              className="scient-latex-page-stage"
              style={
                {
                  ...paperStyle,
                  transform: `scale(${zoom})`,
                } as CSSProperties
              }
            >
              <div className="scient-latex-page-ruler" aria-hidden="true" />
              <div className="scient-latex-visual-paper">
                <div className="scient-latex-page-stack" aria-hidden="true">
                  {Array.from({ length: pageCount }, (_, index) => (
                    <div
                      className="scient-latex-page-sheet"
                      key={index}
                      style={{ top: index * (pageHeight + pageGap) }}
                    >
                      <span>Page {index + 1}</span>
                    </div>
                  ))}
                </div>
                <EditorContent editor={editor} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="scient-latex-visual-summary" role="status">
        <span>{readOnly ? "Read-only" : "Saved to LaTeX"}</span>
        <span>Editing: {selectionContext}</span>
        <span>
          {layout.documentClass} · {layout.baseFontPt}pt · {layout.paper.toUpperCase()}
        </span>
        <span>
          {pageCount} {pageCount === 1 ? "page" : "pages"}
        </span>
        <span>
          {summary.supported} visual {summary.supported === 1 ? "block" : "blocks"}
          {summary.raw > 0 ? ` · ${summary.raw} protected` : ""}
        </span>
      </div>
    </div>
  );
}
