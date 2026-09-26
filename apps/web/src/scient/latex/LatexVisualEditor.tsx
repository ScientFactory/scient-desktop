import type { JSONContent } from "@tiptap/core";
import { matrixEdit, type MatrixAction } from "../math/input/matrix";
import { customMathEdit } from "../keyboard/customMath";
import { attachShortcutHost } from "../keyboard/host";
import {
  commandKeys,
  getKeyboardPreferences,
  subscribeKeyboardPreferences,
} from "../keyboard/preferences";
import { labelKeys } from "../keyboard/keys";
import { commandEdit, mathCommand } from "../math/input/catalog";
import { WritingShortcutsDialog } from "../keyboard/WritingShortcutsDialog";
import { Extension, Node, type Editor } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { NodeViewProps } from "@tiptap/react";
import {
  Fragment,
  createContext,
  useContext,
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
import { LatexInsertMenu, type LatexInsertAction } from "./LatexInsertMenu";
import { LatexDocumentSettings } from "./LatexDocumentSettings";
import {
  DockButton,
  DockMenu,
  DockCommandItem,
  DockCommandRadioItem,
} from "../markdownEditor/ui/dockChrome";
import { MenuRadioGroup, MenuSeparator } from "~/components/ui/menu";
import "../markdownEditor/scient-markdown-editor.css";
import { LatexReferenceDialog } from "./LatexReferenceDialog";
import { LatexFigureInsertDialog } from "./LatexFigureInsertDialog";
import { LatexDocumentReview } from "./LatexDocumentReview";
import { LatexMathField, type LatexMathFieldHandle } from "./LatexMathField";
import { LatexMathPalette } from "./LatexMathPalette";
import { LatexTextField, LatexDraftContext } from "./LatexTextField";
import { LatexObjectToolbar } from "./LatexObjectToolbar";
import { LatexHeadingToolbar } from "./LatexHeadingToolbar";
import { LatexTitleView } from "./LatexTitleView";
import { LatexTableToolbar } from "./LatexTableToolbar";
import { LatexVisualZoomControls } from "./LatexVisualZoomControls";
import { useLatexPinchZoom } from "./useLatexPinchZoom";
import { List, Undo2, Redo2, Sigma, ListTree, ClipboardCheck, Keyboard } from "lucide-react";
import { mathSourceCompletions, type MathSourceCompletion } from "./latexMathCompletion";
import {
  LatexVisualPagination,
  latexPaginationKey,
  latexObjectPageGaps,
  setLatexPaginationDimensions,
} from "./latexVisualPaginationExtension";
import {
  CSS_PIXELS_PER_INCH,
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
  escapeText,
  metadataText,
  latexVisualLayoutProfile,
  latexVisualScientificSource,
  latexVisualTableSource,
  latexVisualTablePresentation,
  latexVisualMathSource,
  parseLatexVisualMathSource,
  parseStructuredMathEnvironment,
  projectLatexVisualDocument,
  updateLatexVisualLayoutSource,
  ensureLatexTitleBlock,
  type LatexVisualDocument,
} from "./latexVisualDocument";

const LatexSourceAttributes = Extension.create({
  name: "latexSourceAttributes",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "bulletList", "orderedList"],
        attributes: {
          referenceLabel: { default: null, rendered: false },
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
  const [paletteRequest, setPaletteRequest] = useState(0);
  const [shortcutHint, setShortcutHint] = useState("");
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

  const sourceShortcut = useRef<(id: string) => boolean>(() => false);
  sourceShortcut.current = (id) => {
    const field = sourceEditor.current;
    if (!field || !editor.isEditable) return false;
    if (id === "math.palette") {
      setSourceOpen(false);
      setPaletteRequest((value) => value + 1);
      return true;
    }
    if (id === "math.inline" || id === "math.display") {
      changeType(id === "math.inline" ? "inline-paren" : "display-bracket");
      return true;
    }
    const source = field.value;
    const selection = { from: field.selectionStart, to: field.selectionEnd };
    const custom = getKeyboardPreferences().preferences.customMath?.find(
      (entry) => entry.id === id,
    );
    const command = mathCommand(id);
    const edit = custom
      ? customMathEdit(custom, source, selection)
      : command
        ? commandEdit(command, source, selection)
        : id.startsWith("math.matrix.")
          ? matrixEdit(source, selection, id.slice("math.matrix.".length) as MatrixAction)
          : null;
    if (!edit) return false;
    const next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    setDraft(next);
    setCaret(edit.selection.from);
    publishSource(next);
    requestAnimationFrame(() => {
      if (sourceEditor.current !== field || field.value !== next) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(edit.selection.from, edit.selection.to);
    });
    return true;
  };
  useEffect(() => {
    const field = sourceEditor.current;
    if (!field || !sourceOpen || !editing) return;
    return attachShortcutHost(field, "math", {
      capture: true,
      feedback: setShortcutHint,
      accepts: (event) => editor.isEditable && !event.isComposing,
      execute: (id) => sourceShortcut.current(id),
    });
  }, [sourceOpen, editing, editor]);

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
            <span className="scient-latex-shortcut-hint" role="status">
              {shortcutHint}
            </span>
            <LatexMathPalette
              openRequest={paletteRequest}
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
        onShortcutHint={setShortcutHint}
        onShortcut={(command) => {
          if (command === "math.palette") {
            setSourceOpen(false);
            setPaletteRequest((value) => value + 1);
            return true;
          }
          if (command === "math.inline" || command === "math.display") {
            changeType(command === "math.inline" ? "inline-paren" : "display-bracket");
            return true;
          }
          return false;
        }}
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

function LatexInlineCommandView({
  node,
  updateAttributes,
  selected,
  editor,
  getPos,
}: NodeViewProps) {
  const editable = useEditorEditable(editor);
  const name = String(node.attrs.name ?? "command");
  const argument = String(node.attrs.argument ?? "");
  const root = useRef<HTMLSpanElement>(null);
  const host = editor.view.dom.closest(".scient-latex-visual-workspace");
  const footnoteText = name === "footnote" ? metadataText(argument) : null;
  useEffect(() => {
    if (!selected || !editable) return;
    const frame = requestAnimationFrame(() =>
      host
        ?.querySelector<HTMLTextAreaElement>(`[aria-label="${name} argument"]`)
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [selected, editable, host, name]);
  return (
    <NodeViewWrapper
      as="span"
      ref={root}
      className="scient-latex-visual-command"
      data-selected={selected || undefined}
      contentEditable={false}
    >
      <button
        type="button"
        disabled={!editable}
        aria-label={`Edit ${name}`}
        onClick={() => {
          const position = getPos();
          if (typeof position === "number") editor.commands.setNodeSelection(position);
          requestAnimationFrame(() =>
            host
              ?.querySelector<HTMLTextAreaElement>(`[aria-label="${name} argument"]`)
              ?.focus({ preventScroll: true }),
          );
        }}
      >
        {name === "footnote" ? (
          <ScientTooltip content={footnoteText ?? argument}>
            <sup>*</sup>
          </ScientTooltip>
        ) : (
          <span>{name === "label" ? `(${argument || "label"})` : `[${argument || name}]`}</span>
        )}
      </button>
      <LatexObjectToolbar editor={editor} root={root} selected={selected} label={`${name} options`}>
        <span className="scient-latex-context-label">
          {name === "footnote" ? "Footnote" : name === "label" ? "Reference label" : name}
        </span>
        <LatexTextField
          aria-label={`${name} argument`}
          rows={1}
          value={footnoteText ?? argument}
          onValueChange={(value) => {
            const next = name === "footnote" && footnoteText !== null ? escapeText(value) : value;
            if (name !== "footnote" && /[{}\\%]/u.test(next)) return;
            if (name === "footnote" && footnoteText === null && /[{}%]/u.test(next)) return;
            updateAttributes({ argument: next, raw: `\\${name}{${next}}` });
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
              event.preventDefault();
              const position = getPos();
              if (typeof position === "number")
                editor.commands.setTextSelection(position + node.nodeSize);
              editor.commands.focus(undefined, { scrollIntoView: false });
            }
          }}
        />
      </LatexObjectToolbar>
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
  readonly draftKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly relativePath: string | null;
}

const LatexRootContext = createContext<string | null>(null);

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
  const rootRelativePath = useContext(LatexRootContext);
  const relativePath =
    rootRelativePath === null ? null : normalizeFigurePath(rootRelativePath, props.path);
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
  getPos,
  workspace,
}: NodeViewProps & { readonly workspace: LatexVisualWorkspace }) {
  const editorEditable = useEditorEditable(editor);
  const generatedId = useRef(0);
  const tableRoot = useRef<HTMLElement | null>(null);
  const objectRoot = useRef<HTMLElement | null>(null);
  const [descriptionItem, setDescriptionItem] = useState(0);
  const [captionEditing, setCaptionEditing] = useState(false);
  const selectObject = () => {
    const position = getPos();
    if (typeof position === "number" && editor.state.selection.from !== position)
      editor.view.dispatch(
        editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)),
      );
  };
  const leaveObject = (direction: -1 | 1) => {
    const position = getPos();
    if (typeof position !== "number") return;
    const boundary = direction < 0 ? position : position + node.nodeSize;
    editor.view.dispatch(
      editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(boundary), direction)),
    );
    editor.commands.focus(undefined, { scrollIntoView: false });
  };
  const [selectedCell, setSelectedCell] = useState({ row: 0, column: 0 });
  const [objectActive, setObjectActive] = useState(false);
  const kind = String(node.attrs.kind ?? "description");
  const fieldDraft = (name: string) =>
    workspace.draftKey ? `${workspace.draftKey}:${node.attrs.sourceId}:${kind}:${name}` : undefined;
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
      items: [...items, { label: "", body: "" }],
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
    nextRowIds.splice(insertion, 0, nextGeneratedId("table-row-new"));
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
    nextColumnIds.splice(insertion, 0, nextGeneratedId("table-column-new"));
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
  const tableShortcut = useRef<(id: string) => boolean>(() => false);
  tableShortcut.current = (id) => {
    if (!editorEditable || !tableEditable) return false;
    if (id === "table.addRow") addTableRow();
    else if (id === "table.deleteRow" && rows.length > 1) removeTableRow();
    else if (id === "table.addColumn") addTableColumn();
    else if (id === "table.deleteColumn" && (rows[0]?.length ?? 0) > 1) removeTableColumn();
    else return false;
    return true;
  };
  useEffect(() => {
    const root = tableRoot.current;
    if (!root || !tableEditable) return;
    return attachShortcutHost(root, "table", {
      capture: true,
      accepts: (event) =>
        editor.isEditable &&
        event.target instanceof Element &&
        Boolean(event.target.closest("[data-table-cell]")),
      execute: (id) => tableShortcut.current(id),
    });
  }, [tableEditable, editor]);
  if (kind === "title") {
    return (
      <LatexTitleView
        node={node}
        updateAttributes={updateAttributes}
        editor={editor}
        selected={selected}
        getPos={getPos}
        draftKey={workspace.draftKey}
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
        <LatexTextField
          aria-label="Abstract"
          draftKey={fieldDraft("body")}
          disabled={!editorEditable || !structureEditable}
          rows={1}
          value={String(node.attrs.body ?? "")}
          onValueChange={(body) => updateAttributes({ body })}
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
        ref={objectRoot}
        onFocusCapture={selectObject}
        onPointerDown={selectObject}
        className="scient-latex-rich-preview scient-latex-figure-preview"
        contentEditable={false}
      >
        <LatexObjectToolbar
          editor={editor}
          root={objectRoot}
          selected={selected}
          label="Figure tools"
        >
          <span className="scient-latex-context-label">Figure</span>
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
          <details className="scient-latex-context-menu">
            <summary>Figure options</summary>
            <div className="scient-latex-context-menu-panel">
              <label>
                Width
                <LatexTextField
                  aria-label="Figure width"
                  rows={1}
                  disabled={!figureEditable}
                  draftKey={fieldDraft("width")}
                  value={String(node.attrs.figureWidth ?? "")}
                  onValueChange={(figureWidth) => updateAttributes({ figureWidth })}
                />
              </label>
              <label>
                Placement
                <LatexTextField
                  aria-label="Figure placement"
                  rows={1}
                  disabled={!figureEditable}
                  draftKey={fieldDraft("placement")}
                  value={String(node.attrs.figurePlacement ?? "")}
                  onValueChange={(figurePlacement) => updateAttributes({ figurePlacement })}
                />
              </label>
              <label>
                Image path
                <LatexTextField
                  aria-label="Figure image path"
                  rows={1}
                  disabled={!figureEditable}
                  draftKey={fieldDraft("path")}
                  value={String(node.attrs.path ?? "")}
                  onValueChange={(path) => updateAttributes({ path })}
                />
              </label>
              <label>
                Reference label
                <LatexTextField
                  aria-label="Figure reference label"
                  rows={1}
                  disabled={!figureEditable}
                  draftKey={fieldDraft("label")}
                  value={String(node.attrs.label ?? "")}
                  onValueChange={(label) => updateAttributes({ label })}
                />
              </label>
              <button disabled={!figureEditable} onClick={deleteNode} type="button">
                Delete figure
              </button>
            </div>
          </details>
        </LatexObjectToolbar>
        <figure data-align={String(node.attrs.figureAlignment ?? "center")}>
          <LatexFigureImage
            alt={String(node.attrs.caption ?? "")}
            path={String(node.attrs.path ?? "")}
            width={String(node.attrs.figureWidth ?? "")}
            workspace={workspace}
          />
          <figcaption>
            <LatexTextField
              aria-label="Figure caption"
              rows={1}
              disabled={!figureEditable}
              draftKey={fieldDraft("caption")}
              value={String(node.attrs.caption ?? "")}
              onValueChange={(caption) => updateAttributes({ caption })}
            />
          </figcaption>
        </figure>
      </NodeViewWrapper>
    );
  }
  if (kind === "scientific") {
    const scientificEditable = structureEditable && editorEditable;
    const environment = String(node.attrs.environment ?? "theorem");
    return (
      <NodeViewWrapper
        ref={objectRoot}
        onFocusCapture={selectObject}
        onPointerDown={selectObject}
        className="scient-latex-rich-preview scient-latex-scientific-preview"
        data-environment={environment}
        contentEditable={false}
      >
        <LatexObjectToolbar
          editor={editor}
          root={objectRoot}
          selected={selected}
          label="Statement options"
        >
          <select
            aria-label="Scientific statement type"
            disabled={!scientificEditable}
            value={environment}
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
            ].map((name) => (
              <option key={name} value={name}>
                {name[0]!.toUpperCase() + name.slice(1)}
              </option>
            ))}
          </select>
          <details className="scient-latex-context-menu">
            <summary>Statement options</summary>
            <div className="scient-latex-context-menu-panel">
              <label>
                Optional title
                <LatexTextField
                  aria-label="Scientific statement title"
                  rows={1}
                  disabled={!scientificEditable}
                  draftKey={fieldDraft("title")}
                  value={String(node.attrs.title ?? "")}
                  onValueChange={(title) => updateAttributes({ title })}
                />
              </label>
              <label>
                Reference label
                <LatexTextField
                  aria-label="Scientific statement reference label"
                  rows={1}
                  disabled={!scientificEditable}
                  draftKey={fieldDraft("label")}
                  value={String(node.attrs.label ?? "")}
                  onValueChange={(label) => updateAttributes({ label })}
                />
              </label>
              <button disabled={!scientificEditable} onClick={deleteNode} type="button">
                Delete statement
              </button>
            </div>
          </details>
        </LatexObjectToolbar>
        <div className="scient-latex-scientific-heading">
          <strong>
            {environment[0]!.toUpperCase() + environment.slice(1)}
            {node.attrs.title ? ` (${String(node.attrs.title)})` : ""}.
          </strong>
        </div>
        <LatexTextField
          aria-label="Scientific statement body"
          disabled={!scientificEditable}
          rows={1}
          draftKey={fieldDraft("body")}
          value={String(node.attrs.body ?? "")}
          onValueChange={(body) => updateAttributes({ body })}
        />
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper
      ref={objectRoot}
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
        selectObject();
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
      {kind === "description" ? (
        <>
          <LatexObjectToolbar
            editor={editor}
            root={objectRoot}
            selected={selected}
            label="Description list options"
          >
            <span className="scient-latex-context-label">Description list</span>
            <button
              disabled={!editorEditable || !descriptionEditable}
              onClick={addDescriptionItem}
              type="button"
            >
              Add item
            </button>
            <button
              disabled={!editorEditable || !descriptionEditable || items.length <= 1}
              onClick={() => removeDescriptionItem(Math.min(descriptionItem, items.length - 1))}
              type="button"
            >
              Remove item
            </button>
          </LatexObjectToolbar>
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
                <div
                  data-latex-description-item={index}
                  onFocusCapture={() => setDescriptionItem(index)}
                >
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
                </div>
              </Fragment>
            ))}
          </dl>
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
          {caption.length > 0 || captionEditing ? (
            <figcaption>
              {captionEditable ? (
                <LatexTextField
                  aria-label="Table caption"
                  draftKey={fieldDraft("caption")}
                  onFocus={() => setCaptionEditing(true)}
                  onBlur={() => setCaptionEditing(false)}
                  rows={1}
                  disabled={!editorEditable}
                  placeholder="Add a table caption"
                  value={caption}
                  onValueChange={(nextCaption) => {
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
                          <LatexTextField
                            aria-label={`Table row ${rowIndex + 1} column ${cellIndex + 1}`}
                            data-table-cell={`${rowIndex}-${cellIndex}`}
                            disabled={!editorEditable}
                            rows={1}
                            value={cell}
                            draftKey={fieldDraft(`cell:${key}:${cellKey}`)}
                            onFocus={() => setSelectedCell({ row: rowIndex, column: cellIndex })}
                            onValueChange={(value) => updateCell(rowIndex, cellIndex, value)}
                            onKeyDown={(event) => {
                              if (event.nativeEvent.isComposing) return;
                              if (
                                (event.ctrlKey || event.metaKey) &&
                                event.key.toLowerCase() === "z"
                              ) {
                                event.preventDefault();
                                if (event.shiftKey) editor.commands.redo();
                                else editor.commands.undo();
                                return;
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                leaveObject(1);
                                return;
                              }
                              const field = event.currentTarget;
                              if (
                                (event.key === "ArrowUp" && field.selectionStart === 0) ||
                                (event.key === "ArrowDown" &&
                                  field.selectionEnd === field.value.length)
                              ) {
                                const nextRow = rowIndex + (event.key === "ArrowUp" ? -1 : 1);
                                if (nextRow >= 0 && nextRow < rows.length) {
                                  event.preventDefault();
                                  focusTableCell(nextRow, cellIndex);
                                }
                                return;
                              }
                              if (event.key !== "Tab") return;
                              const width = row.length;
                              const current = rowIndex * width + cellIndex;
                              const next = current + (event.shiftKey ? -1 : 1);
                              if (next < 0) {
                                event.preventDefault();
                                leaveObject(-1);
                                return;
                              }
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
    return {
      environmentId: null,
      cwd: null,
      relativePath: null,
      draftKey: null,
    };
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
  // Configurable formatting is dispatched by the shared capture adapter. Prevent
  // StarterKit from reviving its fixed bindings after a shortcut is disabled.
  Extension.create({
    name: "sharedWritingKeys",
    priority: 1000,
    addKeyboardShortcuts() {
      return { "Mod-b": () => true, "Mod-i": () => true };
    },
  }),
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
  readonly documentToolsHost?: HTMLDivElement | null;
  readonly onLocalDraftChange?: (pending: boolean) => void;
  readonly draftKey: string;
  readonly fileRevision: string;
  readonly source: string;
  readonly rootSource?: string | null;
  readonly rootRelativePath?: string | null;
  readonly disabled: boolean;
  readonly onEdit: (expected: string, next: string) => boolean;
  readonly onEditingChange: (editing: boolean) => void;
  readonly onOpenSource: () => void;
  readonly environmentId?: EnvironmentId | undefined;
  readonly cwd?: string | undefined;
  readonly relativePath?: string | undefined;
  readonly registerFinishEditing?: (finish: (() => void) | null) => void;
}

const visualJsonNodes = new WeakMap<ProseMirrorNode, JSONContent>();
function visualDocumentJson(doc: ProseMirrorNode): JSONContent {
  const content: JSONContent[] = [];
  doc.forEach((node) => {
    let json = visualJsonNodes.get(node);
    if (!json) {
      json = node.toJSON() as JSONContent;
      visualJsonNodes.set(node, json);
    }
    content.push(json);
  });
  return { type: "doc", content };
}

export function LatexVisualEditor(props: LatexVisualEditorProps) {
  const pendingFields = useRef(new Set<string>());
  const [hasLocalDraft, setHasLocalDraft] = useState(false);
  const reportDraft = useCallback((id: string, pending: boolean) => {
    if (pending) pendingFields.current.add(id);
    else pendingFields.current.delete(id);
    setHasLocalDraft(pendingFields.current.size > 0);
  }, []);
  const onLocalDraftChange = props.onLocalDraftChange;
  useEffect(() => {
    onLocalDraftChange?.(hasLocalDraft);
  }, [hasLocalDraft, onLocalDraftChange]);
  useEffect(() => () => onLocalDraftChange?.(false), [onLocalDraftChange]);

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
  applyDocumentChange.current = (source, document, content) =>
    applyLatexVisualDocumentChange(source, document, content, {
      rootSource: props.rootSource ?? null,
      onMissingRequirement: (message) => setNotice(message),
    });
  const accepted = useRef<{
    doc: ProseMirrorNode;
    expected: string;
    change: NonNullable<ReturnType<typeof applyLatexVisualDocumentChange>>;
  } | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const [editorRevision, refreshToolbar] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const failed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === props.draftKey)
        setNotice(
          "The local recovery copy could not be stored. Keep this document open until its workspace save succeeds.",
        );
    };
    window.addEventListener("scient-latex-recovery-error", failed);
    return () => window.removeEventListener("scient-latex-recovery-error", failed);
  }, [props.draftKey]);
  const [insertOpen, setInsertOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutHint, setShortcutHint] = useState("");
  useSyncExternalStore(
    subscribeKeyboardPreferences,
    getKeyboardPreferences,
    getKeyboardPreferences,
  );
  const shortcutLabel = (id: string) =>
    commandKeys(id)
      .map((keys) => labelKeys(keys))
      .join(" / ");
  const shortcutAction = useRef<(id: string) => boolean>(() => false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [figureOpen, setFigureOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [summary, setSummary] = useState({
    supported: initial.supportedBlocks,
    raw: initial.rawBlocks,
  });
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
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
    const oldSelection = editor.state.selection;
    const scroll = editor.view.dom.closest(".scient-latex-visual-scroll");
    const scrollTop = scroll?.scrollTop ?? 0;
    const scrollLeft = scroll?.scrollLeft ?? 0;
    applying.current = true;
    editor.commands.setContent(next.content, { emitUpdate: false });
    const size = editor.state.doc.content.size;
    const from = Math.min(oldSelection.from, size);
    const to = Math.min(oldSelection.to, size);
    const selection =
      oldSelection instanceof NodeSelection && editor.state.doc.nodeAt(from)?.isAtom
        ? NodeSelection.create(editor.state.doc, from)
        : TextSelection.between(editor.state.doc.resolve(from), editor.state.doc.resolve(to));
    editor.view.dispatch(editor.state.tr.setSelection(selection));
    if (scroll) {
      scroll.scrollTop = scrollTop;
      scroll.scrollLeft = scrollLeft;
    }
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
          : applyDocumentChange.current(expected, projection.current, visualDocumentJson(doc));
      accepted.current = null;
      if (changed === null) {
        setNotice("That structure is source-only. Your LaTeX was not changed.");
        installProjection(projection.current, true);
        return;
      }
      if (changed.source === expected) {
        installProjection(changed.projection, false);
        return;
      }
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
        draftKey: props.draftKey,
        environmentId: props.environmentId ?? null,
        cwd: props.cwd ?? null,
        relativePath: props.relativePath ?? null,
      }),
    [props.cwd, props.environmentId, props.relativePath, props.draftKey],
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
                  visualDocumentJson(transaction.doc),
                );
                const supported = change !== null;
                if (change)
                  accepted.current = {
                    doc: transaction.doc,
                    expected: currentSource.current,
                    change,
                  };
                const field = document.activeElement;
                if (
                  !supported &&
                  !(
                    field instanceof HTMLTextAreaElement &&
                    field.closest(".scient-latex-visual-workspace")
                  )
                )
                  setNotice(
                    (previous) =>
                      previous ??
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
          event.key === "/" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          view.state.selection.empty &&
          view.state.selection.$from.parent.type.name === "paragraph" &&
          view.state.selection.$from.parent.content.size === 0
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
    if (!editor) return;
    return attachShortcutHost(editor.view.dom, ["latex", "math"], {
      capture: true,
      feedback: setShortcutHint,
      accepts: (event) =>
        editor.isEditable &&
        !editor.view.composing &&
        event.target instanceof Element &&
        !event.target.closest('input, textarea, select, math-field, [contenteditable="false"]'),
      execute: (id) => shortcutAction.current(id),
    });
  }, [editor]);

  const fieldContext = useMemo(
    () => ({
      reportDraft,
      undo: (redo: boolean) => {
        if (redo) editor?.commands.redo();
        else editor?.commands.undo();
      },
    }),
    [editor, reportDraft],
  );

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
      const nextLayout = latexVisualLayoutProfile(props.rootSource ?? props.source);
      setLatexPaginationDimensions(editor.view, {
        pageHeight: nextLayout.paperHeightIn * CSS_PIXELS_PER_INCH,
        pageGap: 28,
        marginTop: nextLayout.marginTopIn * CSS_PIXELS_PER_INCH,
        marginBottom: nextLayout.marginBottomIn * CSS_PIXELS_PER_INCH,
      });
    }
    setNotice(null);
  }, [editor, installProjection, props.source, props.rootSource]);

  const registerFinishEditing = props.registerFinishEditing;
  useLayoutEffect(() => {
    registerFinishEditing?.(() => {
      const field = document.activeElement;
      if (
        field instanceof HTMLElement &&
        editor?.view.dom.closest(".scient-latex-visual-workspace")?.contains(field)
      )
        field.blur();
      editor?.commands.blur();
    });
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
    const source = latexVisualTableSource(rows, columns, "plain");
    const table = projectLatexVisualDocument(source).content.content?.[0];
    if (!table) return;
    editor?.chain().focus().insertContent(table).run();
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
      id: "figure",
      label: "Figure",
      description: "Choose an image from your project",
      group: "Objects",
      run: () =>
        props.rootRelativePath
          ? setFigureOpen(true)
          : setNotice("Choose a root document before inserting a figure."),
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
            { type: "paragraph" },
            {
              type: "heading",
              attrs: { level: 2, unnumbered: true },
              content: [{ type: "text", text: "Solution" }],
            },
            { type: "paragraph" },
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
      id: "footnote",
      label: "Footnote",
      description: "Add a note to this text",
      group: "References",
      run: () => {
        editor
          ?.chain()
          .focus()
          .insertContent({
            type: "latexInlineCommand",
            attrs: { name: "footnote", argument: "", raw: "\\footnote{}" },
          })
          .command(({ tr }) => {
            tr.setSelection(NodeSelection.create(tr.doc, tr.selection.from - 1));
            return true;
          })
          .run();
      },
    },
    {
      id: "abstract",
      label: "Abstract",
      description: "Add a summary",
      group: "Academic",
      run: () => insertVisualSource("\\begin{abstract}\n\n\\end{abstract}"),
    },
    {
      id: "contents",
      label: "Table of contents",
      description: "Use the document headings",
      group: "References",
      run: () => insertVisualSource("\\tableofcontents"),
    },
    {
      id: "pagebreak",
      label: "Page break",
      description: "Start the next content on a new page",
      group: "Layout",
      run: () => insertVisualSource("\\newpage"),
    },
  ];
  shortcutAction.current = (id) => {
    if (!editor || readOnly) return false;
    if (id === "latex.shortcuts") {
      setShortcutsOpen(true);
      return true;
    }
    if (id === "latex.outline") {
      setNavigationOpen((value) => !value);
      return true;
    }
    if (id === "latex.bold") return editor.chain().focus().toggleBold().run();
    if (id === "latex.italic") return editor.chain().focus().toggleItalic().run();
    if (id === "latex.bulletList") return editor.chain().focus().toggleBulletList().run();
    if (id === "latex.orderedList") return editor.chain().focus().toggleOrderedList().run();
    if (id === "latex.table") {
      insertTable(2, 2);
      return true;
    }
    if (id === "math.palette") {
      setInsertOpen(true);
      return true;
    }
    if (id === "math.inline" || id === "math.display") {
      insertMath(id === "math.display");
      return true;
    }
    if (id.startsWith("math.")) {
      const command = mathCommand(id);
      const custom = getKeyboardPreferences().preferences.customMath?.find(
        (entry) => entry.id === id,
      );
      if (!command && !custom) return false;
      const selected = editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      );
      const edit = custom
        ? customMathEdit(custom, selected, { from: 0, to: selected.length })
        : commandEdit(command!, selected, { from: 0, to: selected.length });
      return insertVisualMath(editor, false, edit.insert);
    }
    const actionId =
      (
        { section: "heading-1", subsection: "heading-2", subsubsection: "heading-3" } as Record<
          string,
          string
        >
      )[id.slice(6)] ?? id.slice(6);
    const action = insertActions.find((entry) => entry.id === actionId);
    if (!action) return false;
    action.run();
    return true;
  };
  const documentTools = (
    <>
      <WritingShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        environmentId={props.environmentId}
      />
      <ScientTooltip content="Writing shortcuts">
        <button
          type="button"
          className="scient-latex-action"
          aria-label="Writing shortcuts"
          onClick={() => setShortcutsOpen(true)}
        >
          <Keyboard className="size-3.5" />
        </button>
      </ScientTooltip>
      <LatexDocumentSettings
        source={props.source}
        disabled={readOnly}
        onOpenSource={props.onOpenSource}
        onApply={(draft) => {
          const expected = currentSource.current;
          const next = updateLatexVisualLayoutSource(expected, draft);
          if (next === null || !onEdit.current(expected, next)) return false;
          currentSource.current = next;
          installProjection(projectLatexVisualDocument(next), true);
          return true;
        }}
        onTitle={(field) => {
          const expected = currentSource.current;
          const name =
            props.relativePath
              ?.split(/[\\/]/u)
              .at(-1)
              ?.replace(/\.tex$/iu, "") ?? "Untitled";
          const next = ensureLatexTitleBlock(expected, name);
          if (next === null) {
            setNotice("Open the document root to add a title block.");
            return;
          }
          if (next !== expected) {
            if (!onEdit.current(expected, next)) return;
            currentSource.current = next;
            installProjection(projectLatexVisualDocument(next), true);
          }
          requestAnimationFrame(() => {
            const root = editor?.view.dom.querySelector<HTMLElement>(".scient-latex-title-preview");
            const target = root?.querySelector<HTMLTextAreaElement>(
              `[aria-label="Document ${field}"]`,
            );
            if (target?.disabled) {
              setNotice(
                `This ${field} contains custom formatting. Edit it in LaTeX to preserve that formatting.`,
              );
              return;
            }
            root?.dispatchEvent(new CustomEvent("scient-latex-edit-title", { detail: field }));
          });
        }}
      />
      <ScientTooltip content="Document outline">
        <button
          type="button"
          className="scient-latex-action"
          aria-label="Document outline"
          aria-pressed={navigationOpen}
          onClick={() => setNavigationOpen((open) => !open)}
        >
          <ListTree className="size-3.5" />
        </button>
      </ScientTooltip>
      <ScientTooltip content="Review document">
        <button
          type="button"
          className="scient-latex-action"
          aria-label="Review document"
          onClick={() => setReviewOpen(true)}
        >
          <ClipboardCheck className="size-3.5" />
        </button>
      </ScientTooltip>
    </>
  );
  const layout = useMemo(
    () => latexVisualLayoutProfile(props.rootSource ?? props.source),
    [props.source, props.rootSource],
  );
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
  ];

  return (
    <LatexRootContext value={props.rootRelativePath ?? null}>
      <LatexDraftContext value={fieldContext}>
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
                disabled={props.disabled}
                onClick={() => {
                  if (onEdit.current(currentSource.current, recovery)) setRecovery(null);
                }}
              >
                Restore recovered source
              </button>
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
          {props.documentToolsHost ? (
            createPortal(documentTools, props.documentToolsHost)
          ) : (
            <div className="scient-latex-document-tools">{documentTools}</div>
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
              <DockMenu
                label="Paragraph style"
                icon={
                  <span>
                    {editor?.isActive("heading")
                      ? ["Section", "Subsection", "Subsubsection"][
                          Number(editor.getAttributes("heading").level) - 1
                        ]
                      : "Normal text"}
                  </span>
                }
              >
                <MenuRadioGroup
                  value={
                    editor?.isActive("heading")
                      ? String(editor.getAttributes("heading").level)
                      : "paragraph"
                  }
                >
                  <DockCommandRadioItem
                    value="paragraph"
                    onClick={() => {
                      editor?.chain().focus().setParagraph().run();
                    }}
                  >
                    Normal text
                  </DockCommandRadioItem>
                  {([1, 2, 3] as const).map((level) => (
                    <DockCommandRadioItem
                      key={level}
                      value={String(level)}
                      onClick={() => {
                        editor?.chain().focus().setHeading({ level }).run();
                      }}
                    >
                      {["Section", "Subsection", "Subsubsection"][level - 1]}
                    </DockCommandRadioItem>
                  ))}
                </MenuRadioGroup>
              </DockMenu>
              {formatActions
                .filter((item) => !item.secondary)
                .map((item) => (
                  <DockButton
                    key={item.label}
                    label={`${item.label}${shortcutLabel(item.label === "Bold" ? "latex.bold" : "latex.italic") ? " (" + shortcutLabel(item.label === "Bold" ? "latex.bold" : "latex.italic") + ")" : ""}`}
                    icon={item.icon}
                    disabled={readOnly || !editor}
                    active={Boolean(item.active)}
                    onClick={item.action}
                  />
                ))}
              <DockMenu label="Lists" icon={<List />}>
                <DockCommandItem
                  onClick={() => {
                    editor?.chain().focus().toggleBulletList().run();
                  }}
                  disabled={readOnly}
                >
                  Bullet list
                </DockCommandItem>
                <DockCommandItem
                  onClick={() => {
                    editor?.chain().focus().toggleOrderedList().run();
                  }}
                  disabled={readOnly}
                >
                  Numbered list
                </DockCommandItem>
                <MenuSeparator />
                <DockCommandItem
                  onClick={() => {
                    editor?.chain().focus().sinkListItem("listItem").run();
                  }}
                  disabled={readOnly || !editor?.can().sinkListItem("listItem")}
                >
                  Indent item
                </DockCommandItem>
                <DockCommandItem
                  onClick={() => {
                    editor?.chain().focus().liftListItem("listItem").run();
                  }}
                  disabled={readOnly || !editor?.can().liftListItem("listItem")}
                >
                  Outdent item
                </DockCommandItem>
              </DockMenu>
            </div>
            <div className="scient-latex-toolbar-group">
              <LatexInsertMenu
                open={insertOpen && !readOnly}
                onOpenChange={setInsertOpen}
                actions={insertActions}
                disabled={readOnly}
                onInsertTable={insertTable}
                onReturnFocus={() => editor?.commands.focus(undefined, { scrollIntoView: false })}
              />
              <DockButton
                label={`Insert equation${shortcutLabel("math.display") ? " (" + shortcutLabel("math.display") + ")" : ""}`}
                icon={<Sigma />}
                disabled={readOnly}
                onClick={() => insertDisplayMath(MATH_INSERTIONS.equation)}
              />
            </div>
            <div className="scient-latex-toolbar-history">
              <DockButton
                label="Undo (Ctrl/Cmd+Z)"
                icon={<Undo2 />}
                disabled={readOnly || !editor?.can().undo()}
                onClick={() => {
                  editor?.chain().focus().undo().run();
                }}
              />
              <DockButton
                label="Redo (Ctrl/Cmd+Shift+Z)"
                icon={<Redo2 />}
                disabled={readOnly || !editor?.can().redo()}
                onClick={() => {
                  editor?.chain().focus().redo().run();
                }}
              />
            </div>
            <span className="scient-latex-shortcut-hint" role="status">
              {shortcutHint}
            </span>
            <LatexVisualZoomControls
              zoom={zoom}
              fit={zoomMode === "fit"}
              onZoom={setZoomMode}
              onFit={() => setZoomMode("fit")}
            />
          </div>
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
              relativePath={props.rootRelativePath ?? ""}
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
            <div className="scient-latex-context-tools-slot">
              {editor && !readOnly && editor.isActive("heading") ? (
                <LatexHeadingToolbar editor={editor} draftKey={props.draftKey} />
              ) : null}
            </div>
            <div className="scient-latex-document-status" role="status">
              <span className="scient-latex-selection-status">
                {readOnly ? "Read-only" : selectionContext}
              </span>
              {hasLocalDraft ? (
                <ScientTooltip content="This field has a local draft. Complete the entry to update the LaTeX source.">
                  <span className="scient-latex-draft-status">Editing draft</span>
                </ScientTooltip>
              ) : null}
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
      </LatexDraftContext>
    </LatexRootContext>
  );
}
