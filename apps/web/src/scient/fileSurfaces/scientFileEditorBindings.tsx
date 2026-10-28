import { useStableCallback } from "~/hooks/useStableCallback";
import type { EditorSelection } from "@pierre/diffs/edit";
import type { GetHoveredLineResult, SelectedLineRange } from "@pierre/diffs";
import type { Editor } from "@pierre/diffs/edit";
import { MessageSquarePlus } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
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
  editor: Editor<"file", Annotation, undefined> | null;
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
  const reportExternalVersion = useStableCallback((version: number) =>
    externalBindings.current.onExternalVersionApplied?.(version),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers an external-projection applier with the editor persistence layer until unmount
  useLayoutEffect(
    () =>
      externalPersistence?.registerExternalProjection((update) => {
        if (!editor || !editor.getFile() || editor.isComposing) return "defer";
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
          applyExternalProjection(
            () => {
              prepared();
              reportExternalVersion(update.editVersion);
            },
            () => {
              applyingExternal.current = false;
            },
          );
        };
      }),
    [applyingExternal, editor, externalPersistence, reportExternalVersion],
  );

  const reportEditorSelection = () => {
    if (onEditorSelectionChange === undefined) return;
    if (editorSelectionFrameRef.current !== null) {
      cancelAnimationFrame(editorSelectionFrameRef.current);
    }
    editorSelectionFrameRef.current = requestAnimationFrame(() => {
      editorSelectionFrameRef.current = null;
      onEditorSelectionChange(editor?.getViewState().selections?.at(-1) ?? null);
    });
  };
  const mathEditable = useRef(!editingBlocked);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps a ref mirroring whether editing is blocked for imperative math handlers to read
  useLayoutEffect(() => {
    mathEditable.current = !editingBlocked;
  });
  const canEditMath = useStableCallback(() => mathEditable.current);
  const mathInput = (() => {
    const format = /\.tex$/iu.test(relativePath)
      ? "latex"
      : /\.(?:md|markdown)$/iu.test(relativePath)
        ? "markdown"
        : null;
    return format && editor ? sourceMathController(editor, format, canEditMath) : null;
  })();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the math input controller to the surface DOM node until unmount
  useEffect(() => {
    const host = surfaceRef.current;
    if (!host || !mathInput) return;
    return mathInput.attach(host, sourceMathOwnsEvent);
  }, [mathInput, surfaceRef]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- installs LaTeX completion on the editor and surface DOM node until unmount
  useEffect(() => {
    const host = surfaceRef.current;
    if (!host || !editor || !/\.tex$/iu.test(relativePath)) return;
    return installLatexFileCompletion(editor, host, () => mathEditable.current);
  }, [editor, relativePath, surfaceRef]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps a ref mirroring the selection reporter for the document listener to call
  useLayoutEffect(() => {
    reportEditorSelectionRef.current = reportEditorSelection;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for document selectionchange events and reports the editor selection until unmount
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
      onRunShortcut(editor?.getViewState().selections?.at(-1) ?? null);
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
  const base =
    gutterUtilityVisibility === "hover"
      ? FILE_EDITOR_ACTION_GUTTER_UNSAFE_CSS
      : SCIENT_FILE_UNSAFE_CSS;
  return `${base}
    :host([data-scient-retained-selection]) [data-caret] {
      visibility: visible !important;
    }
    :host([data-scient-retained-selection]:not(:focus-within)) [data-caret] {
      animation: none;
      opacity: 0.65;
    }
  `;
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

function applyExternalProjection(apply: () => void, finish: () => void) {
  try {
    apply();
  } finally {
    finish();
  }
}
