import { Extension, Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { NodeViewProps } from "@tiptap/react";
import {
  Fragment,
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
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import { EditorState, Plugin, NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { LatexInsertDialog, type LatexInsertAction } from "./LatexInsertDialog";
import { LatexReferenceDialog } from "./LatexReferenceDialog";
import { LatexFigureInsertDialog } from "./LatexFigureInsertDialog";
import { LatexDocumentReview } from "./LatexDocumentReview";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { LatexMathPalette } from "./LatexMathPalette";
import { LatexTitleView } from "./LatexTitleView";
import { LatexTableToolbar } from "./LatexTableToolbar";
import { LatexVisualZoomControls } from "./LatexVisualZoomControls";
import { useLatexPinchZoom } from "./useLatexPinchZoom";
import { List, ListOrdered, Undo2, Redo2, Plus, Sigma, MoreHorizontal } from "lucide-react";
import { mathSourceCompletions, type MathSourceCompletion } from "./latexMathCompletion";
import {
  LatexVisualPagination,
  latexPaginationKey,
  latexObjectPageGaps,
  setLatexPaginationDimensions,
} from "./latexVisualPaginationExtension";
import {
  CSS_PIXELS_PER_INCH,
  LATEX_PAPER_SIZES,
  TEX_POINTS_PER_INCH,
  latexLengthInches,
  latexVisualFontMetrics,
} from "./latexVisualLayout";
import "katex/dist/katex-swap.min.css";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { useAssetUrlState } from "~/assets/assetUrls";
import { readVisualDraft, clearVisualDraft } from "./visualDrafts";

import {
  applyLatexVisualDocumentChange,
  latexVisualLayoutProfile,
  latexVisualScientificSource,
  latexVisualTableSource,
  latexVisualTablePresentation,
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
          latexCommand: {
            default: null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.latexCommand
                ? { "data-latex-command": String(attributes.latexCommand) }
                : {},
          },
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

function mathType(
  attributes: { environment?: string | null; wrapper?: unknown },
  display: boolean,
) {
  if (!display) return attributes.wrapper === "dollar" ? "inline-dollar" : "inline-paren";
  if (attributes.environment) return `environment:${attributes.environment}`;
  return attributes.wrapper === "double-dollar" ? "display-dollar" : "display-bracket";
}

function insertVisualMath(editor: Editor, display: boolean, tex = ""): boolean {
  if (!editor.isEditable) return false;
  const type = display ? "latexDisplayMath" : "latexInlineMath";
  return editor
    .chain()
    .focus()
    .insertContent({ type, attrs: { tex, wrapper: display ? "bracket" : "paren" } })
    .command(({ tr }) => {
      const caret = tr.selection.from;
      let nearestPosition = -1;
      let nearestDistance = Infinity;
      tr.doc.descendants((candidate, position) => {
        if (
          candidate.type.name !== type ||
          candidate.attrs.sourceId != null ||
          candidate.attrs.tex !== tex
        )
          return;
        const distance = Math.abs(position + candidate.nodeSize - caret);
        if (distance < nearestDistance) {
          nearestPosition = position;
          nearestDistance = distance;
        }
      });
      if (nearestPosition >= 0) tr.setSelection(NodeSelection.create(tr.doc, nearestPosition));
      return true;
    })
    .run();
}

function LatexMathView({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const display = node.type.name === "latexDisplayMath";
  const editable = useEditorEditable(editor);
  const mathField = useRef<LatexMathFieldHandle>(null);
  const sourceEditor = useRef<HTMLTextAreaElement>(null);
  const activationId = useId();
  const mathRoot = useRef<HTMLDivElement>(null);
  const mathBar = useRef<HTMLDivElement>(null);
  const attributes = {
    tex: String(node.attrs.tex ?? ""),
    environment: node.attrs.environment ? String(node.attrs.environment) : null,
    wrapper: node.attrs.wrapper,
  } as const;
  const [editing, setEditing] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [draft, setDraft] = useState(attributes.tex);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const completions = useMemo(
    () => mathSourceCompletions(draft, caret, true).slice(0, 6),
    [caret, draft],
  );

  useEffect(() => {
    const deactivate = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== activationId) {
        setEditing(false);
        setSourceOpen(false);
      }
    };
    document.addEventListener("scient-latex-context-activate", deactivate);
    return () => document.removeEventListener("scient-latex-context-activate", deactivate);
  }, [activationId]);

  const activate = (focus = true) => {
    if (!editable) return;
    document.dispatchEvent(
      new CustomEvent("scient-latex-context-activate", { detail: activationId }),
    );
    setSourceOpen(false);
    setDraft(attributes.tex);
    setSourceError(null);
    setEditing(true);
    if (focus) requestAnimationFrame(() => mathField.current?.focus());
  };

  const activateRef = useRef(activate);
  activateRef.current = activate;
  useEffect(() => {
    if (selected && editable) activateRef.current();
  }, [selected, editable]);

  useEffect(() => {
    if (!editing) return;
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (path.includes(mathRoot.current!) || path.includes(mathBar.current!)) return;
      // MathLive mounts command suggestions on document.body, outside the node.
      if (
        path.some(
          (target) => target instanceof Element && target.id === "mathlive-suggestion-popover",
        )
      )
        return;
      setEditing(false);
      setSourceOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [editing]);

  const finish = (direction: -1 | 1 = 1) => {
    setEditing(false);
    setSourceOpen(false);
    const position = getPos();
    if (position === undefined || editor.isDestroyed) return;
    const current = editor.state.doc.nodeAt(position);
    if (!current) return;
    const boundary = direction > 0 ? position + current.nodeSize : position;
    const transaction = editor.state.tr;
    const adjacent =
      direction > 0
        ? transaction.doc.resolve(boundary).nodeAfter
        : transaction.doc.resolve(boundary).nodeBefore;
    if (display && !adjacent?.isTextblock && editor.isEditable) {
      const paragraph = editor.schema.nodes.paragraph!.create();
      transaction.insert(boundary, paragraph);
      transaction.setSelection(TextSelection.create(transaction.doc, boundary + 1));
    } else {
      transaction.setSelection(Selection.near(transaction.doc.resolve(boundary), direction));
    }
    editor.view.dispatch(transaction.scrollIntoView());
    editor.view.focus();
  };

  const publishSource = (value: string) => {
    if (!editor.isEditable) return;
    const tex = display ? value.trim() : value;
    const parsed = parseLatexVisualMathSource(
      latexVisualMathSource({ ...attributes, tex }, display),
      display,
    );
    if (!parsed) {
      setSourceError(
        "Not saved: numbering, labels and command definitions belong in the document source.",
      );
      return;
    }
    // Keep half-typed delimiters local instead of sending a rejected edit to
    // the document and showing a document-wide warning on every keystroke.
    const projected = projectLatexVisualDocument(
      latexVisualMathSource({ ...attributes, tex }, display),
    ).content.content;
    const formula = display ? projected?.[0] : projected?.[0]?.content?.[0];
    if (
      projected?.length !== 1 ||
      (!display && projected[0]?.content?.length !== 1) ||
      formula?.type !== node.type.name ||
      String(formula.attrs?.tex ?? "").trim() !== tex.trim()
    ) {
      setSourceError("Not saved yet. Complete the formula without its outer math delimiters.");
      return;
    }
    updateAttributes({ tex });
    const position = getPos();
    const accepted = position === undefined ? null : editor.state.doc.nodeAt(position);
    setSourceError(
      accepted?.attrs.tex === tex
        ? null
        : "Not saved yet. Keep only the formula here; change its type using the selector.",
    );
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
    publishSource(next);
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
      setDraft(nextAttributes.tex);
      setSourceError(null);
      return;
    }
    const position = getPos();
    if (position === undefined) return;
    if (display) {
      const inlineNode = editor.schema.nodes.latexInlineMath?.create(nextAttributes);
      const paragraph = inlineNode ? editor.schema.nodes.paragraph?.create(null, inlineNode) : null;
      if (paragraph) {
        const transaction = editor.state.tr.replaceWith(
          position,
          position + node.nodeSize,
          paragraph,
        );
        transaction.setSelection(NodeSelection.create(transaction.doc, position + 1));
        editor.view.dispatch(transaction);
      }
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
    if (displayNode) {
      const transaction = editor.state.tr.replaceWith(
        resolved.before(),
        resolved.after(),
        displayNode,
      );
      transaction.setSelection(NodeSelection.create(transaction.doc, resolved.before()));
      editor.view.dispatch(transaction);
    }
  };

  const toolbarHost = editor.view.dom
    .closest(".scient-latex-visual-workspace")
    ?.querySelector(".scient-latex-context-tools-slot");
  const toolbar =
    editing && toolbarHost
      ? createPortal(
          <div
            ref={mathBar}
            className="scient-latex-context-toolbar scient-latex-math-bar"
            role="toolbar"
            aria-label="Math tools"
            onClick={(event) => event.stopPropagation()}
          >
            <select
              aria-label="Equation type"
              value={mathType(attributes, display)
                .replace("inline-dollar", "inline-paren")
                .replace("display-dollar", "display-bracket")}
              onChange={(event) => changeType(event.currentTarget.value)}
            >
              <option value="inline-paren">Inline</option>
              <option value="display-bracket">Centered</option>
              <option value="environment:equation">Numbered</option>
              <option value="environment:equation*">Unnumbered</option>
              <option value="environment:align">Align (numbered)</option>
              <option value="environment:align*">Align (unnumbered)</option>
              <option value="environment:gather">Gather (numbered)</option>
              <option value="environment:gather*">Gather (unnumbered)</option>
            </select>
            <LatexMathPalette
              sourceOpen={sourceOpen}
              onOpen={() => setSourceOpen(false)}
              onInsert={(symbol) =>
                symbol.action
                  ? mathField.current?.command(symbol.action)
                  : mathField.current?.insert(symbol.latex)
              }
              onCommand={(command) => mathField.current?.command(command) ?? false}
              onReturnToMath={() => mathField.current?.focus()}
            />
            <button
              className="scient-latex-math-bar-source"
              aria-pressed={sourceOpen}
              type="button"
              onClick={() => {
                if (sourceOpen) {
                  setSourceOpen(false);
                  if (!sourceError) mathField.current?.focus();
                } else {
                  if (!sourceError) setDraft(attributes.tex);
                  setSourceOpen(true);
                  requestAnimationFrame(() => sourceEditor.current?.focus());
                }
              }}
            >
              LaTeX
            </button>
            {editing && sourceOpen ? (
              <div
                className="scient-latex-math-source-popover"
                role="dialog"
                aria-label="Equation source"
                onClick={(event) => event.stopPropagation()}
              >
                <textarea
                  ref={sourceEditor}
                  aria-label="LaTeX formula code"
                  aria-invalid={Boolean(sourceError)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={draft}
                  rows={Math.min(8, Math.max(2, draft.split("\n").length))}
                  onChange={(event) => {
                    setDraft(event.currentTarget.value);
                    setCaret(event.currentTarget.selectionStart);
                    if (!(event.nativeEvent as InputEvent).isComposing)
                      publishSource(event.currentTarget.value);
                  }}
                  onCompositionEnd={(event) => publishSource(event.currentTarget.value)}
                  onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.nativeEvent.isComposing) return;
                    if (
                      event.key === "Escape" ||
                      (event.key === "Enter" && (event.ctrlKey || event.metaKey))
                    ) {
                      event.preventDefault();
                      if (!sourceError) {
                        setSourceOpen(false);
                        mathField.current?.focus();
                      }
                    } else if (event.key === "Tab" && !event.shiftKey && completions[0]) {
                      event.preventDefault();
                      applyCompletion(completions[0]);
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
              </div>
            ) : null}

            {sourceError && !sourceOpen ? (
              <div className="scient-latex-math-bar-error" role="status">
                {sourceError}
              </div>
            ) : null}
          </div>,
          toolbarHost,
        )
      : null;
  return (
    <NodeViewWrapper
      ref={mathRoot}
      as={display ? "div" : "span"}
      className={display ? "scient-latex-visual-display-math" : "scient-latex-visual-inline-math"}
      contentEditable={false}
      data-selected={selected || editing || undefined}
      data-empty={!attributes.tex.trim() || undefined}
      onClick={(event: MouseEvent<HTMLElement>) => {
        // MathLive already placed the caret (or drag selection) at the clicked
        // symbol. Only clicks in the surrounding whitespace need help focusing.
        if (
          event.nativeEvent
            .composedPath()
            .some((target) => target instanceof Element && target.tagName === "MATH-FIELD")
        )
          return;
        activate();
      }}
    >
      <LatexMathField
        ref={mathField}
        value={attributes.tex}
        display={display}
        disabled={!editable}
        onFocus={() => activate(false)}
        onExit={finish}
        onRemoveEmpty={() => {
          const position = getPos();
          if (position === undefined || !editor.isEditable) return;
          const current = editor.state.doc.nodeAt(position);
          if (!current || current.attrs.tex !== "") return;
          const transaction = editor.state.tr.delete(position, position + current.nodeSize);
          transaction.setSelection(
            Selection.near(
              transaction.doc.resolve(Math.min(position, transaction.doc.content.size)),
            ),
          );
          editor.view.dispatch(transaction.scrollIntoView());
          editor.view.focus();
        }}
        onChange={(tex) => {
          if (editor.isEditable) {
            updateAttributes({ tex });
            setDraft(tex);
          }
          const position = getPos();
          return String(
            (position === undefined ? node : editor.state.doc.nodeAt(position))?.attrs.tex ??
              node.attrs.tex ??
              "",
          );
        }}
      />
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
  const inches = latexLengthInches(width);
  return inches !== null && inches > 0 ? `${inches * CSS_PIXELS_PER_INCH}px` : undefined;
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
  decorations,
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
  const controlsVisible = kind === "table" ? objectActive : selected || objectActive;
  const tableEditable = kind === "table" && structureEditable;
  const objectPageGaps = useMemo(() => latexObjectPageGaps(decorations, node), [decorations, node]);
  const tablePresentation = useMemo(
    () => latexVisualTablePresentation(String(node.attrs.raw ?? "")),
    [node.attrs.raw],
  );
  useEffect(() => {
    if (kind !== "table") return;
    setSelectedCell((cell) => {
      const row = Math.max(0, Math.min(cell.row, rows.length - 1));
      const column = Math.max(0, Math.min(cell.column, (rows[0]?.length ?? 1) - 1));
      return row === cell.row && column === cell.column ? cell : { row, column };
    });
  }, [kind, rows.length, rows[0]?.length]);
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
    const used = new Set([...itemIds, ...rowIds, ...columnIds]);
    let id: string;
    do {
      generatedId.current += 1;
      id = `${prefix}-${generatedId.current}`;
    } while (used.has(id));
    return id;
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
  const focusCellWhitespace = (event: MouseEvent<HTMLTableCellElement>) => {
    if (!editorEditable || !tableEditable || event.button !== 0) return;
    const field = event.currentTarget.querySelector<HTMLTextAreaElement>(
      "textarea[data-table-cell]",
    );
    // Keep native caret placement and drag selection when clicking the text.
    if (!field || field.disabled || event.target === field) return;
    // Cells can be wider/taller than their text-sized editor. Route the spare
    // area to that editor before ProseMirror selects the entire table atom.
    event.preventDefault();
    event.stopPropagation();
    const bounds = field.getBoundingClientRect();
    const caret =
      event.clientY < bounds.top || event.clientX < bounds.left ? 0 : field.value.length;
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, caret);
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
    return (
      <LatexTitleView
        node={node}
        updateAttributes={updateAttributes}
        editor={editor}
        selected={selected}
        editable={editorEditable}
      />
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
            {entries.map((entry, index) => (
              <Fragment key={String(entry.number)}>
                {objectPageGaps[index] ? (
                  <li
                    className="scient-latex-object-page-gap"
                    aria-hidden="true"
                    style={{ height: objectPageGaps[index] }}
                  />
                ) : null}
                <li data-level={Number(entry.level ?? 1)} data-latex-toc-entry={index}>
                  <span>{String(entry.number ?? "")}</span>
                  <span>{String(entry.title ?? "")}</span>
                </li>
              </Fragment>
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
      onFocusCapture={() => {
        if (kind !== "table") setObjectActive(true);
      }}
      onBlurCapture={(event: FocusEvent<HTMLElement>) => {
        if (
          kind !== "table" &&
          !event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)
        )
          setObjectActive(false);
      }}
    >
      {kind !== "table" ? (
        <div className="scient-latex-rich-preview-label">
          <span>Description list</span>
          <span>
            {structureEditable
              ? "Editable structure - LaTeX preserved"
              : "Protected source - edit in Source"}
          </span>
        </div>
      ) : null}
      {kind === "description" ? (
        <>
          <dl>
            {keyedItems.map(({ index, key, value: item }) => (
              <Fragment key={key}>
                {objectPageGaps[index] ? (
                  <div
                    className="scient-latex-object-page-gap"
                    aria-hidden="true"
                    style={{ height: objectPageGaps[index] }}
                  />
                ) : null}
                <div data-latex-description-item={index}>
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
              </Fragment>
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
        <figure
          ref={tableRoot}
          data-table-style={String(node.attrs.tableStyle ?? "plain")}
          data-table-kind={String(node.attrs.tableKind ?? "fixed")}
        >
          <LatexTableToolbar
            editor={editor}
            tableRoot={tableRoot}
            selected={selected}
            editable={editorEditable && tableEditable}
            row={selectedCell.row}
            column={selectedCell.column}
            rowCount={rows.length}
            columnCount={rows[0]?.length ?? 0}
            style={String(node.attrs.tableStyle ?? "plain")}
            width={String(node.attrs.tableKind ?? "fixed")}
            header={node.attrs.hasHeader === true}
            alignment={columnAlignments[selectedCell.column] ?? "left"}
            caption={caption}
            label={tableLabel}
            captionEditable={captionEditable}
            labelEditable={labelEditable}
            onActiveChange={setObjectActive}
            onAddRow={addTableRow}
            onRemoveRow={removeTableRow}
            onMoveRow={moveTableRow}
            onAddColumn={addTableColumn}
            onRemoveColumn={removeTableColumn}
            onMoveColumn={moveTableColumn}
            onStyle={(tableStyle) => updateTableStructure({ tableStyle })}
            onWidth={(tableKind) => updateTableStructure({ tableKind })}
            onHeader={() => updateTableStructure({ hasHeader: node.attrs.hasHeader !== true })}
            onAlignment={(alignment) => {
              const next = [...columnAlignments];
              next[selectedCell.column] = alignment as (typeof columnAlignments)[number];
              updateTableStructure({ columnAlignments: next });
            }}
            onCaption={(caption) => {
              if (sourceMeta?.captionRange === null) updateTableStructure({ caption });
              else updateAttributes({ caption });
            }}
            onLabel={(label) => {
              if (sourceMeta?.labelRange === null) updateTableStructure({ label });
              else updateAttributes({ label });
            }}
            onDelete={deleteNode}
          />
          {caption.length > 0 ? (
            <figcaption>
              {captionEditable ? (
                <textarea
                  aria-label="Table caption"
                  rows={1}
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
                caption
              )}
            </figcaption>
          ) : null}
          <div className="scient-latex-rich-table-scroll">
            <table
              data-trim-left={
                (!node.attrs.tableCanonical && tablePresentation.trimLeft) || undefined
              }
              data-trim-right={
                (!node.attrs.tableCanonical && tablePresentation.trimRight) || undefined
              }
              style={{
                fontSize: `var(--scient-latex-size-${tablePresentation.size})`,
                lineHeight: `var(--scient-latex-baseline-${tablePresentation.size})`,
              }}
            >
              {!node.attrs.tableCanonical &&
              tablePresentation.columnWidths.some((width) => width !== null) ? (
                <colgroup>
                  {tablePresentation.columnWidths.map((width, index) => (
                    <col
                      key={columnIds[index] ?? index}
                      style={
                        width === null
                          ? undefined
                          : {
                              width: `${
                                width * CSS_PIXELS_PER_INCH +
                                (12 * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH -
                                (index === 0 && tablePresentation.trimLeft
                                  ? (6 * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH
                                  : 0) -
                                (index === tablePresentation.columnWidths.length - 1 &&
                                tablePresentation.trimRight
                                  ? (6 * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH
                                  : 0)
                              }px`,
                            }
                      }
                    />
                  ))}
                </colgroup>
              ) : null}
              <tbody>
                {keyedRows.map(({ index: rowIndex, key, value: row }) => (
                  <Fragment key={key}>
                    {objectPageGaps[rowIndex] ? (
                      <tr key="page-gap" className="scient-latex-table-page-gap" aria-hidden="true">
                        <td colSpan={Math.max(1, row.length)}>
                          <div style={{ height: objectPageGaps[rowIndex] }} />
                        </td>
                      </tr>
                    ) : null}
                    <tr
                      key="row"
                      data-latex-table-row={rowIndex}
                      data-page-start={Boolean(objectPageGaps[rowIndex]) || undefined}
                      data-page-end={Boolean(objectPageGaps[rowIndex + 1]) || undefined}
                    >
                      {(tableEditable
                        ? row.map((cell, index) => ({
                            index,
                            key: columnIds[index] ?? `table-column-${index}`,
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
                            onMouseDownCapture={focusCellWhitespace}
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
                            onMouseDownCapture={focusCellWhitespace}
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
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      )}
    </NodeViewWrapper>
  );
}

function stopMathControlEvent({ event }: { event: Event }): boolean {
  // A math-field is a custom element, so Tiptap's default INPUT/TEXTAREA check
  // misses it. Let it own symbol selection, clipboard and keyboard interaction.
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        (target.tagName === "MATH-FIELD" ||
          target.classList.contains("scient-latex-math-source-popover")),
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
    return ReactNodeViewRenderer(LatexMathView, { stopEvent: stopMathControlEvent });
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
    return ReactNodeViewRenderer(LatexMathView, { stopEvent: stopMathControlEvent });
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
    return ReactNodeViewRenderer(
      (props) => <LatexRichPreviewView {...props} workspace={workspace} />,
      {
        update({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) {
          if (oldNode !== newNode || oldDecorations !== newDecorations) updateProps();
          return true;
        },
      },
    );
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
  equation: "",
  bmatrix: "\\begin{bmatrix}\n & \\\\\n & \n\\end{bmatrix}",
  pmatrix: "\\begin{pmatrix}\n & \\\\\n & \n\\end{pmatrix}",
  cases: "\\begin{cases}\n & \\\\\n & \n\\end{cases}",
  aligned: "\\begin{aligned}\n & \\\\\n & \n\\end{aligned}",
} as const;

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
  // The ProseMirror plugins live for the editor's lifetime. Keep their source
  // adapter current across renderer hot updates without resetting user edits.
  const applyDocumentChange = useRef(applyLatexVisualDocumentChange);
  applyDocumentChange.current = applyLatexVisualDocumentChange;
  const accepted = useRef<{
    doc: ProseMirrorNode;
    expected: string;
    change: NonNullable<ReturnType<typeof applyLatexVisualDocumentChange>>;
  } | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const [editorRevision, refreshToolbar] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [figureOpen, setFigureOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [tablePreset, setTablePreset] = useState<LatexVisualTablePreset>("booktabs");
  const [tablePickerSize, setTablePickerSize] = useState({ rows: 3, columns: 3 });
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
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomMode, setZoomMode] = useState<"fit" | number>("fit");
  const [fitZoom, setFitZoom] = useState(1);
  const visualScroll = useRef<HTMLDivElement | null>(null);
  const moreTools = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (moreTools.current?.open && !event.composedPath().includes(moreTools.current))
        moreTools.current.open = false;
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);

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
          : applyDocumentChange.current(expected, projection.current, doc.toJSON());
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
      LatexVisualPagination.configure({ onPageCount: setPageCount }),
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
                const change = applyDocumentChange.current(
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
                    "This change could not be safely written to LaTeX. Your source was left unchanged.",
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
      handleKeyDown(view, event) {
        if (event.isComposing || view.composing || !view.editable) return false;
        if (
          editorRef.current &&
          ((event.altKey && !event.ctrlKey && !event.metaKey && event.code === "Equal") ||
            ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m"))
        ) {
          event.preventDefault();
          return insertVisualMath(editorRef.current, event.shiftKey);
        }

        if (
          (event.key === "/" && (event.metaKey || event.ctrlKey)) ||
          (event.key === "/" &&
            !event.altKey &&
            view.state.selection.empty &&
            view.state.selection.$from.parent.type.name === "paragraph" &&
            view.state.selection.$from.parent.content.size === 0)
        ) {
          event.preventDefault();
          setInsertOpen(true);
          return true;
        }
        return false;
      },
      attributes: {
        class: "scient-latex-visual-document",
        "aria-label": "Visual LaTeX document editor",
      },
    },
    onUpdate: ({ editor: updated }) => handleUpdateRef.current(updated.state.doc),
    onSelectionUpdate: () => refreshToolbar((value) => value + 1),
    onTransaction: ({ transaction }) => {
      if (!transaction.getMeta(latexPaginationKey)) refreshToolbar((value) => value + 1);
    },
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
    if (editor) {
      editor.view.updateState(
        EditorState.create({
          schema: editor.schema,
          doc: editor.state.doc,
          plugins: editor.state.plugins,
        }),
      );
      const nextLayout = latexVisualLayoutProfile(props.source);
      setLatexPaginationDimensions(editor.view, {
        pageHeight: nextLayout.paperHeightIn * CSS_PIXELS_PER_INCH,
        pageGap: 28,
        marginTop: nextLayout.marginTopIn * CSS_PIXELS_PER_INCH,
        marginBottom: nextLayout.marginBottomIn * CSS_PIXELS_PER_INCH,
      });
    }
    setNotice(null);
  }, [editor, installProjection, props.source]);

  const registerFinishEditing = props.registerFinishEditing;
  useLayoutEffect(() => {
    registerFinishEditing?.(() => editor?.commands.blur());
    return () => registerFinishEditing?.(null);
  }, [editor, registerFinishEditing]);

  const onEditingChange = props.onEditingChange;
  useEffect(() => () => onEditingChange(false), [onEditingChange]);

  const insertMath = (display: boolean, tex = "") => {
    if (editor && !readOnly) insertVisualMath(editor, display, tex);
  };
  const insertDisplayMath = (tex = "") => insertMath(true, tex);

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
    if (moreTools.current) moreTools.current.open = false;
  };
  const insertReference = (command: string, key: string) => {
    if (readOnly || !key || /[{}\\%]/u.test(key)) return;
    editor
      ?.chain()
      .focus()
      .insertContent({
        type: "latexInlineCommand",
        attrs: {
          name: command,
          argument: key,
          raw: `\\${command}{${key}}`,
        },
      })
      .run();
  };
  const insertActions: LatexInsertAction[] = [
    ...([1, 2, 3] as const).map((level) => ({
      id: `heading-${level}`,
      label: ["Section", "Subsection", "Subsubsection"][level - 1]!,
      description: "Add a heading to the document outline",
      group: "Text",
      run: () => {
        editor?.chain().focus().setHeading({ level }).run();
      },
    })),
    {
      id: "paragraph",
      label: "Paragraph",
      description: "Continue with ordinary text",
      group: "Text",
      run: () => {
        editor?.chain().focus().setParagraph().run();
      },
    },
    {
      id: "inline-math",
      label: "Inline equation",
      description: "Write mathematics within a sentence (Alt+=)",
      group: "Math",
      run: () => insertMath(false),
    },
    ...Object.entries(MATH_INSERTIONS).map(([id, tex]) => ({
      id,
      label: (
        {
          equation: "Display equation",
          bmatrix: "Bracket matrix",
          pmatrix: "Parentheses matrix",
          cases: "Cases",
          aligned: "Aligned calculation",
        } as Record<string, string>
      )[id]!,
      description: "Insert editable mathematics",
      group: "Math",
      run: () => {
        insertDisplayMath(tex);
      },
    })),
    {
      id: "table",
      label: "Table",
      description: "Choose a grid size and table style",
      group: "Objects",
      run: () => {
        if (tablePicker.current) {
          if (moreTools.current) moreTools.current.open = true;
          tablePicker.current.open = true;
          tablePicker.current.querySelector<HTMLElement>("select")?.focus();
        }
      },
    },
    {
      id: "figure",
      label: "Figure",
      description: "Choose an image from your project",
      group: "Objects",
      run: () => setFigureOpen(true),
    },
    ...[
      "theorem",
      "definition",
      "proof",
      "lemma",
      "claim",
      "proposition",
      "corollary",
      "example",
      "remark",
    ].map((environment) => ({
      id: environment,
      label: environment[0]!.toUpperCase() + environment.slice(1),
      description: "Add an academic statement",
      group: "Academic",
      run: () => {
        const source = latexVisualScientificSource(environment);
        if (source) insertVisualSource(source);
      },
    })),
    {
      id: "question",
      label: "Question and solution",
      description: "A numbered question followed by an editable solution",
      group: "Assignment",
      run: () => {
        editor
          ?.chain()
          .focus()
          .insertContent([
            { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Question" }] },
            { type: "paragraph", content: [{ type: "text", text: "Write the question here." }] },
            {
              type: "heading",
              attrs: { level: 2, unnumbered: true },
              content: [{ type: "text", text: "Solution" }],
            },
            { type: "paragraph", content: [{ type: "text", text: "Write your solution here." }] },
          ])
          .run();
      },
    },
    {
      id: "subquestions",
      label: "Subquestions",
      description: "Add a numbered list of parts",
      group: "Assignment",
      run: () => {
        editor?.chain().focus().toggleOrderedList().run();
      },
    },
    {
      id: "reference",
      label: "Citation or cross-reference",
      description: "Find a source or a labelled document object",
      group: "References",
      run: () => setReferenceOpen(true),
    },
    {
      id: "pagebreak",
      label: "Page break",
      description: "Start the next content on a new page",
      group: "Layout",
      run: () => insertVisualSource("\\newpage"),
    },
  ];
  const layout = useMemo(() => latexVisualLayoutProfile(props.source), [props.source]);
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
  const pageHeight = layout.paperHeightIn * CSS_PIXELS_PER_INCH;
  const paperWidth = layout.paperWidthIn * CSS_PIXELS_PER_INCH;
  const pageGap = 28;
  const texPixels = (points: number) => `${(points * CSS_PIXELS_PER_INCH) / TEX_POINTS_PER_INCH}px`;
  const paperStyle = {
    ...Object.fromEntries(
      Object.entries(latexVisualFontMetrics(layout.baseFontPt)).flatMap(
        ([name, [size, baseline]]) => [
          [`--scient-latex-size-${name}`, texPixels(size)],
          [`--scient-latex-baseline-${name}`, texPixels(baseline)],
        ],
      ),
    ),
    ...Object.fromEntries(
      Object.entries(layout.lists).flatMap(([kind, list]) => [
        [`--scient-latex-${kind}-topsep`, `${list.topSepEm}em`],
        [`--scient-latex-${kind}-itemsep`, `${list.itemSepEm + list.parsepEm}em`],
        [`--scient-latex-${kind}-parsep`, `${list.parsepEm}em`],
        [`--scient-latex-${kind}-leftmargin`, `${list.leftMarginEm}em`],
      ]),
    ),
    "--scient-latex-paper-width": `${paperWidth}px`,
    "--scient-latex-paper-height": `${pageHeight}px`,
    "--scient-latex-page-gap": `${pageGap}px`,
    "--scient-latex-margin-top": `${layout.marginTopIn}in`,
    "--scient-latex-margin-right": `${layout.marginRightIn}in`,
    "--scient-latex-margin-bottom": `${layout.marginBottomIn}in`,
    "--scient-latex-margin-left": `${layout.marginLeftIn}in`,
    "--scient-latex-font-size": texPixels(layout.fontSizePt),
    "--scient-latex-font-family": layout.fontFamily,
    "--scient-latex-text-align": layout.textAlign,
    "--scient-latex-section-size": texPixels(layout.sectionSizePt),
    "--scient-latex-subsection-size": texPixels(layout.subsectionSizePt),
    "--scient-latex-subsubsection-size": texPixels(layout.subsubsectionSizePt),
    "--scient-latex-title-size": texPixels(layout.titleSizePt),
    "--scient-latex-author-size": texPixels(layout.authorSizePt),
    "--scient-latex-line-height": String(layout.lineHeight),
    "--scient-latex-par-indent": `${layout.paragraphIndentEm}em`,
    "--scient-latex-par-gap": `${layout.paragraphGapEm}em`,
  } as CSSProperties;

  const layoutKey = JSON.stringify(layout);
  useLayoutEffect(() => {
    if (!editor) return;
    setLatexPaginationDimensions(editor.view, {
      pageHeight,
      pageGap,
      marginTop: layout.marginTopIn * CSS_PIXELS_PER_INCH,
      marginBottom: layout.marginBottomIn * CSS_PIXELS_PER_INCH,
    });
  }, [editor, layoutKey, layout.marginTopIn, layout.marginBottomIn, pageHeight]);

  useLayoutEffect(() => {
    const scroll = visualScroll.current;
    if (!scroll) return;
    const updateFitZoom = () => {
      const style = getComputedStyle(scroll);
      const available = Math.max(
        1,
        scroll.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
      );
      setFitZoom(available / paperWidth);
    };
    updateFitZoom();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFitZoom);
    observer?.observe(scroll);
    return () => observer?.disconnect();
  }, [paperWidth]);

  const zoom = zoomMode === "fit" ? fitZoom : zoomMode;
  useLatexPinchZoom(visualScroll, zoom, setZoomMode);
  const pageStackHeight = pageCount * pageHeight + (pageCount - 1) * pageGap;
  const stageHeight = pageStackHeight;

  useEffect(() => {
    const scroll = visualScroll.current;
    if (!scroll) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const paper = scroll.querySelector<HTMLElement>(".scient-latex-visual-paper");
      if (!paper) return;
      const top = scroll.getBoundingClientRect().top + Math.min(160, scroll.clientHeight / 3);
      setCurrentPage(
        Math.max(
          1,
          Math.min(
            pageCount,
            Math.floor(
              (top - paper.getBoundingClientRect().top) / (zoom * (pageHeight + pageGap)),
            ) + 1,
          ),
        ),
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroll.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      scroll.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, [pageCount, pageHeight, zoom]);

  const formatActions = [
    {
      label: "Bold",
      icon: <strong>B</strong>,
      action: () => editor?.chain().focus().toggleBold().run(),
      active: editor?.isActive("bold"),
      secondary: false,
    },
    {
      label: "Italic",
      icon: <em>I</em>,
      action: () => editor?.chain().focus().toggleItalic().run(),
      active: editor?.isActive("italic"),
      secondary: false,
    },
    {
      label: "Bullet list",
      icon: <List />,
      action: () => editor?.chain().focus().toggleBulletList().run(),
      active: editor?.isActive("bulletList"),
      secondary: true,
    },
    {
      label: "Numbered list",
      icon: <ListOrdered />,
      action: () => editor?.chain().focus().toggleOrderedList().run(),
      active: editor?.isActive("orderedList"),
      secondary: true,
    },
    {
      label: "Undo",
      icon: <Undo2 />,
      action: () => editor?.chain().focus().undo().run(),
      active: false,
      secondary: true,
    },
    {
      label: "Redo",
      icon: <Redo2 />,
      action: () => editor?.chain().focus().redo().run(),
      active: false,
      secondary: true,
    },
  ];

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
      <div
        className="scient-latex-writing-toolbar"
        role="toolbar"
        aria-label="Writing tools"
        onMouseDown={(event) => {
          if (event.target instanceof Element && event.target.closest("button"))
            event.preventDefault();
        }}
      >
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
            <option value="1">Section</option>
            <option value="2">Subsection</option>
            <option value="3">Subsubsection</option>
          </select>
          {formatActions.map((item) => (
            <ScientTooltip key={item.label} content={item.label}>
              <button
                type="button"
                aria-label={item.label}
                aria-pressed={Boolean(item.active)}
                className={
                  item.secondary ? "scient-latex-toolbar-secondary" : "scient-latex-toolbar-format"
                }
                disabled={readOnly || !editor}
                onClick={item.action}
              >
                {item.icon}
              </button>
            </ScientTooltip>
          ))}
        </div>

        <div className="scient-latex-toolbar-group">
          <button
            type="button"
            aria-label="Insert"
            title="Insert"
            disabled={readOnly}
            onClick={() => setInsertOpen(true)}
          >
            <Plus aria-hidden="true" />
            <span className="scient-latex-insert-label">Insert</span>
          </button>
          <button
            type="button"
            disabled={readOnly}
            title="Insert an empty equation (Ctrl/Cmd+Shift+M)"
            aria-label="Insert equation"
            onClick={() => insertDisplayMath(MATH_INSERTIONS.equation)}
          >
            <Sigma aria-hidden="true" />
          </button>
        </div>
        <details
          ref={moreTools}
          className="scient-latex-more-tools"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.open = false;
              event.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary aria-label="More writing tools" title="More writing tools">
            <MoreHorizontal aria-hidden="true" />
          </summary>
          <div className="scient-latex-more-popover">
            <div className="scient-latex-more-formatting">
              {formatActions.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className={
                    item.secondary ? "scient-latex-more-secondary" : "scient-latex-more-primary"
                  }
                  aria-pressed={Boolean(item.active)}
                  disabled={readOnly || !editor}
                  onClick={() => {
                    item.action();
                    if (moreTools.current) moreTools.current.open = false;
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
            <div className="scient-latex-toolbar-group">
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
                      const active =
                        row <= tablePickerSize.rows && column <= tablePickerSize.columns;
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
              <button
                type="button"
                disabled={readOnly}
                onClick={() => {
                  setReferenceOpen(true);
                  if (moreTools.current) moreTools.current.open = false;
                }}
              >
                Cite / Refer...
              </button>
            </div>
            <div className="scient-latex-toolbar-group" aria-label="Document layout">
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
                <summary aria-disabled={readOnly}>Document settings</summary>
                <div className="scient-latex-layout-popover">
                  <label>
                    Paper
                    <select
                      disabled={readOnly}
                      value={layoutDraft.paper}
                      onChange={(event) =>
                        setLayoutDraft((value) => ({
                          ...value,
                          paper: event.currentTarget.value as keyof typeof LATEX_PAPER_SIZES,
                        }))
                      }
                    >
                      {Object.entries(LATEX_PAPER_SIZES).map(([value, paper]) => (
                        <option key={value} value={value}>
                          {paper.label}
                        </option>
                      ))}
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
                      if (moreTools.current) moreTools.current.open = false;
                    }}
                    type="button"
                  >
                    Apply layout
                  </button>
                  <p>Applies to the whole document. Update the PDF to see the final result.</p>
                </div>
              </details>
            </div>

            <button
              type="button"
              aria-expanded={navigationOpen}
              onClick={() => {
                setNavigationOpen((open) => !open);
                if (moreTools.current) moreTools.current.open = false;
              }}
            >
              Outline
            </button>
            <button
              type="button"
              onClick={() => {
                setReviewOpen(true);
                if (moreTools.current) moreTools.current.open = false;
              }}
            >
              Review
            </button>
          </div>
        </details>
        <LatexVisualZoomControls
          zoom={zoom}
          fit={zoomMode === "fit"}
          onZoom={setZoomMode}
          onFit={() => setZoomMode("fit")}
        />
      </div>
      <LatexInsertDialog
        open={insertOpen && !readOnly}
        onOpenChange={setInsertOpen}
        actions={insertActions}
      />
      <LatexReferenceDialog
        open={referenceOpen && !readOnly}
        onOpenChange={setReferenceOpen}
        source={props.source}
        environmentId={props.environmentId}
        cwd={props.cwd}
        relativePath={props.relativePath}
        onInsert={insertReference}
      />
      {props.environmentId && props.cwd ? (
        <LatexFigureInsertDialog
          open={figureOpen && !readOnly}
          onOpenChange={setFigureOpen}
          environmentId={props.environmentId}
          cwd={props.cwd}
          relativePath={props.relativePath ?? ""}
          source={props.source}
          onInsert={insertVisualSource}
        />
      ) : null}
      <LatexDocumentReview
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        source={props.source}
        onOpenSource={props.onOpenSource}
      />
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
              <div
                className="scient-latex-visual-paper"
                data-indent-after-heading={layout.indentAfterHeading}
              >
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
      <footer className="scient-latex-visual-summary">
        <div className="scient-latex-context-tools-slot" />
        <div className="scient-latex-document-status" role="status">
          <span className="scient-latex-selection-status">
            {readOnly ? "Read-only" : selectionContext}
          </span>
          <span className="scient-latex-layout-status">
            {layout.documentClass} · {layout.baseFontPt}pt · {layout.paper.toUpperCase()}
          </span>
          <span
            className="scient-latex-page-status"
            aria-label={`Page ${Math.min(currentPage, pageCount)} of ${pageCount}`}
          >
            {Math.min(currentPage, pageCount)} / {pageCount}
          </span>
          {summary.raw > 0 ? (
            <button
              className="scient-latex-source-status"
              type="button"
              onClick={props.onOpenSource}
            >
              {summary.raw} source-only {summary.raw === 1 ? "block" : "blocks"}
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
