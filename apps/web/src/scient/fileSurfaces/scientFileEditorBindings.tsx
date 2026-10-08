import type { EditorSelection, GetHoveredLineResult, SelectedLineRange } from "@pierre/diffs";
import type { Editor } from "@pierre/diffs/editor";
import { MessageSquarePlus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";

import { MathInputTools } from "~/scient/math/input/MathInputTools";
import type { MathInputController } from "~/scient/math/input/controller";
import { sourceMathController, sourceMathOwnsEvent } from "~/scient/math/input/sourceAdapter";
import { installLatexFileCompletion } from "~/scient/latex/latexFileCompletion";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";

import { SCIENT_FILE_UNSAFE_CSS } from "./StaticTextFileSurface";

/**
 * Scient behaviour of the inherited workspace file editor: external document
 * session edits projected into the open editor, the reported editor
 * selection, the source math input, and the run shortcut.
 */
export function useScientFileEditorBindings<Annotation>({
  editor,
  relativePath,
  editingBlocked,
  surfaceRef,
  externalPersistence,
  externalBindings,
  applyingExternal,
  editorSelectionFrameRef,
  reportEditorSelectionRef,
  onEditorSelectionChange,
  onRunShortcut,
}: {
  editor: Editor<Annotation>;
  relativePath: string;
  editingBlocked: boolean;
  surfaceRef: RefObject<HTMLDivElement | null>;
  externalPersistence: MarkdownPersistenceLease | undefined;
  externalBindings: MutableRefObject<{
    externalPersistence: MarkdownPersistenceLease | undefined;
    onExternalVersionApplied: ((version: number) => void) | undefined;
  }>;
  applyingExternal: MutableRefObject<boolean>;
  editorSelectionFrameRef: MutableRefObject<number | null>;
  reportEditorSelectionRef: MutableRefObject<() => void>;
  onEditorSelectionChange: ((selection: EditorSelection | null) => void) | undefined;
  onRunShortcut: ((selection: EditorSelection | null) => void) | undefined;
}) {
  useLayoutEffect(
    () =>
      externalPersistence?.registerExternalProjection((update) => {
        if (!editor.getFile() || editor.isComposing) return "defer";
        const prepared = editor.prepareExternalEdits(
          update.previousSource,
          update.patches.map((patch) => ({
            start: patch.start,
            end: patch.end,
            text: patch.replacement,
          })),
        );
        if (!prepared) return null;
        return () => {
          applyingExternal.current = true;
          try {
            prepared();
            externalBindings.current.onExternalVersionApplied?.(update.editVersion);
          } finally {
            applyingExternal.current = false;
          }
        };
      }),
    [applyingExternal, editor, externalPersistence],
  );

  const reportEditorSelection = useCallback(() => {
    if (onEditorSelectionChange === undefined) return;
    if (editorSelectionFrameRef.current !== null) {
      cancelAnimationFrame(editorSelectionFrameRef.current);
    }
    editorSelectionFrameRef.current = requestAnimationFrame(() => {
      editorSelectionFrameRef.current = null;
      onEditorSelectionChange(editor.getState().selections?.at(-1) ?? null);
    });
  }, [editor, editorSelectionFrameRef, onEditorSelectionChange]);
  const mathEditable = useRef(!editingBlocked);
  mathEditable.current = !editingBlocked;
  const mathInput = useMemo(() => {
    const format = /\.tex$/iu.test(relativePath)
      ? "latex"
      : /\.(?:md|markdown)$/iu.test(relativePath)
        ? "markdown"
        : null;
    return format ? sourceMathController(editor, format, () => mathEditable.current) : null;
  }, [editor, relativePath]);
  useEffect(() => {
    const host = surfaceRef.current;
    if (!host || !mathInput) return;
    return mathInput.attach(host, sourceMathOwnsEvent);
  }, [mathInput, surfaceRef]);
  useEffect(() => {
    const host = surfaceRef.current;
    if (!host || !/\.tex$/iu.test(relativePath)) return;
    return installLatexFileCompletion(editor, host, () => mathEditable.current);
  }, [editor, relativePath, surfaceRef]);
  reportEditorSelectionRef.current = reportEditorSelection;

  useEffect(() => {
    if (onEditorSelectionChange === undefined) return;
    const handleSelectionChange = () => {
      const surface = surfaceRef.current;
      if (surface === null || !surface.contains(document.activeElement)) return;
      reportEditorSelection();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (editorSelectionFrameRef.current !== null) {
        cancelAnimationFrame(editorSelectionFrameRef.current);
        editorSelectionFrameRef.current = null;
      }
    };
  }, [editorSelectionFrameRef, onEditorSelectionChange, reportEditorSelection, surfaceRef]);

  return {
    mathInput,
    onCompositionEnd: () =>
      queueMicrotask(() => externalBindings.current.externalPersistence?.resumeExternalUpdates()),
    onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        onRunShortcut === undefined ||
        event.key !== "Enter" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      onRunShortcut(editor.getState().selections?.at(-1) ?? null);
    },
  };
}

/** The source math input row above an editable `.tex` or Markdown source. */
export function ScientMathSourceToolbar(props: {
  readonly mathInput: MathInputController | null;
  readonly editingBlocked: boolean;
}) {
  return props.mathInput && !props.editingBlocked ? (
    <div className="scient-math-source-toolbar">
      <MathInputTools controller={props.mathInput} />
    </div>
  ) : null;
}

const FILE_EDITOR_ACTION_GUTTER_UNSAFE_CSS = `
  ${SCIENT_FILE_UNSAFE_CSS}

  [data-gutter-utility-slot] {
    right: auto;
    left: 0;
    justify-content: flex-start;
    opacity: 0;
    pointer-events: none;
  }

  [data-line]:hover [data-gutter-utility-slot],
  [data-line]:focus-within [data-gutter-utility-slot],
  [data-gutter-utility-slot]:focus-within {
    opacity: 1;
    pointer-events: auto;
  }
`;

/** The editor's styles; compute actions stay quiet until their source line is engaged. */
export function scientFileEditorUnsafeCss(gutterUtilityVisibility: "always" | "hover"): string {
  return gutterUtilityVisibility === "hover"
    ? FILE_EDITOR_ACTION_GUTTER_UNSAFE_CSS
    : SCIENT_FILE_UNSAFE_CSS;
}

/**
 * The editor's gutter utility when a surface adds its own action (the compute
 * run-cell button): that action, then Add comment for the hovered line.
 */
export function scientEditorGutterUtility(
  renderEditorGutterAction:
    | ((getHoveredLine: () => GetHoveredLineResult<"file"> | undefined) => ReactNode)
    | undefined,
  enableFileComments: boolean,
  handleGutterUtilityClick: (range: SelectedLineRange) => void,
) {
  return renderEditorGutterAction === undefined
    ? {}
    : {
        renderGutterUtility: (getHoveredLine: () => GetHoveredLineResult<"file"> | undefined) => (
          <div className="flex items-center gap-px">
            {renderEditorGutterAction(getHoveredLine)}
            {enableFileComments ? (
              <button
                type="button"
                className="flex size-5 cursor-pointer items-center justify-center rounded-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Add comment"
                onClick={() => {
                  const hoveredLine = getHoveredLine();
                  if (hoveredLine !== undefined) {
                    handleGutterUtilityClick({
                      start: hoveredLine.lineNumber,
                      end: hoveredLine.lineNumber,
                    });
                  }
                }}
              >
                <MessageSquarePlus className="size-3" />
              </button>
            ) : null}
          </div>
        ),
      };
}
