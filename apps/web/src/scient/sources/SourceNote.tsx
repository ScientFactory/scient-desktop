import type { ScientSourceDetailResult, ScientSourceNoteUpdateResult } from "@t3tools/contracts";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_STAR,
  ITALIC_STAR,
} from "@lexical/markdown";
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { StickyNote, X } from "lucide-react";
import {
  $getSelection,
  $getRoot,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type EditorState,
  type LexicalEditor,
  type TextFormatType,
} from "lexical";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";

import { cn } from "~/lib/utils";

import { Button } from "../../components/ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ScientTooltip } from "../presentation/ScientTooltip";

const NOTE_AUTOSAVE_DELAY_MS = 600;
const NOTE_MAX_LENGTH = 100_000;

type NoteStatus = "saved" | "pending" | "saving" | "conflict" | "error";
const NOTE_EDITOR_SYNC_TAG = "scient-source-note-external-sync";
const NOTE_MARKDOWN_TRANSFORMERS = [BOLD_ITALIC_STAR, BOLD_STAR, ITALIC_STAR];

interface SourceNoteFormats {
  readonly bold: boolean;
  readonly italic: boolean;
}

const EMPTY_SOURCE_NOTE_FORMATS: SourceNoteFormats = {
  bold: false,
  italic: false,
};

function noteText(record: ScientSourceDetailResult): string {
  return record.note ?? "";
}

function useSourceNoteState(input: {
  readonly record: ScientSourceDetailResult;
  readonly onSave: (
    note: string | null,
    expectedRevision: number,
  ) => Promise<ScientSourceNoteUpdateResult>;
}) {
  const [draft, setDraft] = useState(() => noteText(input.record));
  const [confirmed, setConfirmed] = useState(() => noteText(input.record));
  const [status, setStatus] = useState<NoteStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const recordRef = useRef(input.record);
  const draftRef = useRef(draft);
  const confirmedRef = useRef(confirmed);
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const saveAgainRef = useRef(false);
  const conflictRef = useRef(false);
  const onSaveRef = useRef(input.onSave);
  onSaveRef.current = input.onSave;

  useEffect(() => {
    recordRef.current = input.record;
    const remote = noteText(input.record);
    if (remote === draftRef.current) {
      confirmedRef.current = remote;
      setConfirmed(remote);
      setStatus("saved");
      setError(null);
      return;
    }
    if (draftRef.current === confirmedRef.current) {
      draftRef.current = remote;
      confirmedRef.current = remote;
      setDraft(remote);
      setConfirmed(remote);
      setStatus("saved");
      setError(null);
    }
  }, [input.record]);

  const persist = useCallback(async () => {
    if (savingRef.current) {
      saveAgainRef.current = true;
      return;
    }
    const submitted = draftRef.current;
    if (submitted === confirmedRef.current) return;

    const base = recordRef.current;
    savingRef.current = true;
    if (mountedRef.current) {
      setStatus("saving");
      setError(null);
    }
    let continueSaving = false;
    try {
      const result = await onSaveRef.current(submitted.trim() ? submitted : null, base.revision);
      recordRef.current = result.record;
      const remote = noteText(result.record);
      if (result.outcome === "stale" && remote !== confirmedRef.current && remote !== submitted) {
        conflictRef.current = true;
        if (mountedRef.current) {
          setStatus("conflict");
          setError("This note changed elsewhere. Your text is preserved here.");
        }
        return;
      }

      confirmedRef.current = remote;
      if (mountedRef.current) {
        setConfirmed(remote);
        setStatus(draftRef.current === remote ? "saved" : "pending");
      }
      continueSaving = true;
    } catch {
      if (mountedRef.current) {
        setStatus("error");
        setError("Note could not be saved. Keep typing or leave and return to retry.");
      }
    } finally {
      savingRef.current = false;
      if (
        continueSaving &&
        !conflictRef.current &&
        (saveAgainRef.current || draftRef.current !== confirmedRef.current)
      ) {
        saveAgainRef.current = false;
        void persist();
      }
    }
  }, []);

  useEffect(() => {
    if (draft === confirmed || status === "conflict" || status === "error") return;
    const timer = setTimeout(() => void persist(), NOTE_AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [confirmed, draft, persist, status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (draftRef.current !== confirmedRef.current) void persist();
    };
  }, [persist]);

  const change = (value: string) => {
    conflictRef.current = false;
    draftRef.current = value;
    setDraft(value);
    setStatus(value === confirmedRef.current ? "saved" : "pending");
    setError(null);
  };

  return { change, draft, error, flush: persist, status } as const;
}

function NoteStatusLine(props: { readonly status: NoteStatus; readonly error: string | null }) {
  if (props.error) {
    return (
      <p className="text-xs text-destructive" role="alert">
        {props.error}
      </p>
    );
  }
  return (
    <p className="min-h-4 text-xs text-muted-foreground" role="status" aria-live="polite">
      {props.status === "saving" ? "Saving…" : props.status === "pending" ? "Saving…" : "Saved"}
    </p>
  );
}

interface SourceNoteEditorHandle {
  readonly focusAtEnd: () => void;
  readonly format: (format: Extract<TextFormatType, "bold" | "italic">) => void;
}

function focusEditorAtEnd(editor: LexicalEditor): void {
  editor.update(
    () => {
      $getRoot().selectEnd();
    },
    { onUpdate: () => editor.focus() },
  );
}

function SourceNoteEditorBridge(props: {
  readonly autoFocus: boolean;
  readonly editorRef: RefObject<SourceNoteEditorHandle | null>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onFormatChange: ((formats: SourceNoteFormats) => void) | undefined;
}) {
  const [editor] = useLexicalComposerContext();
  const acceptedValueRef = useRef(props.value);
  const onChangeRef = useRef(props.onChange);
  const onFormatChangeRef = useRef(props.onFormatChange);
  onChangeRef.current = props.onChange;
  onFormatChangeRef.current = props.onFormatChange;

  useImperativeHandle(
    props.editorRef,
    () => ({
      focusAtEnd: () => focusEditorAtEnd(editor),
      format: (format) => {
        editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
        editor.focus();
      },
    }),
    [editor, props.editorRef],
  );

  useEffect(() => {
    if (props.value === acceptedValueRef.current) return;
    acceptedValueRef.current = props.value;
    editor.update(
      () => {
        $convertFromMarkdownString(props.value, NOTE_MARKDOWN_TRANSFORMERS, undefined, true);
      },
      { tag: NOTE_EDITOR_SYNC_TAG },
    );
  }, [editor, props.value]);

  useEffect(() => {
    if (props.autoFocus) focusEditorAtEnd(editor);
  }, [editor, props.autoFocus]);

  useEffect(() => {
    const publishActiveFormats = (editorState: EditorState) => {
      editorState.read(() => {
        const selection = $getSelection();
        onFormatChangeRef.current?.(
          $isRangeSelection(selection)
            ? {
                bold: selection.hasFormat("bold"),
                italic: selection.hasFormat("italic"),
              }
            : EMPTY_SOURCE_NOTE_FORMATS,
        );
      });
    };

    publishActiveFormats(editor.getEditorState());
    return editor.registerUpdateListener(({ editorState }) => {
      publishActiveFormats(editorState);
    });
  }, [editor]);

  const handleChange = useCallback(
    (editorState: EditorState, _editor: unknown, tags: Set<string>) => {
      if (tags.has(NOTE_EDITOR_SYNC_TAG)) return;
      const next = editorState.read(() =>
        $convertToMarkdownString(NOTE_MARKDOWN_TRANSFORMERS, undefined, true),
      );
      if (next.length > NOTE_MAX_LENGTH) {
        editor.update(
          () => {
            $convertFromMarkdownString(
              acceptedValueRef.current,
              NOTE_MARKDOWN_TRANSFORMERS,
              undefined,
              true,
            );
          },
          { tag: NOTE_EDITOR_SYNC_TAG },
        );
        return;
      }
      if (next === acceptedValueRef.current) return;
      acceptedValueRef.current = next;
      onChangeRef.current(next);
    },
    [editor],
  );

  return <OnChangePlugin ignoreSelectionChange onChange={handleChange} />;
}

function SourceNoteEditor(props: {
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly fillAvailableSpace?: boolean;
  readonly editorRef: RefObject<SourceNoteEditorHandle | null>;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onFormatChange?: (formats: SourceNoteFormats) => void;
  readonly onBlur: () => void;
}) {
  const initialConfig: InitialConfigType = {
    namespace: "ScientSourceNote",
    editorState: () => {
      $convertFromMarkdownString(props.value, NOTE_MARKDOWN_TRANSFORMERS, undefined, true);
    },
    onError: (error) => {
      throw error;
    },
    theme: {
      paragraph: "m-0",
      text: { bold: "font-bold", italic: "italic" },
    },
  };

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div
        className={cn(
          "relative w-full cursor-text rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground",
          props.fillAvailableSpace ? "min-h-0 flex-1" : "h-20",
          props.className,
        )}
        dir="auto"
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="h-full w-full overflow-y-auto whitespace-pre-wrap break-words outline-none"
              aria-label="Source note"
              aria-placeholder="Add a note…"
              placeholder={<span />}
              onBlur={props.onBlur}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute start-2 top-1.5 text-muted-foreground">
              Add a note…
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <SourceNoteEditorBridge
          autoFocus={props.autoFocus ?? false}
          editorRef={props.editorRef}
          value={props.value}
          onChange={props.onChange}
          onFormatChange={props.onFormatChange}
        />
      </div>
    </LexicalComposer>
  );
}

function NotePreview(props: { readonly value: string; readonly onEdit: () => void }) {
  return (
    <button
      type="button"
      className="w-full cursor-text rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Edit source note"
      dir="auto"
      onClick={props.onEdit}
    >
      <div className="text-foreground [&_em]:italic [&_p]:m-0 [&_p]:whitespace-pre-wrap [&_p+_p]:mt-2 [&_strong]:font-semibold">
        <ReactMarkdown allowedElements={["p", "strong", "em"]} skipHtml>
          {props.value}
        </ReactMarkdown>
      </div>
    </button>
  );
}

function InlineNoteEditor(props: { readonly note: ReturnType<typeof useSourceNoteState> }) {
  const [editing, setEditing] = useState(() => props.note.draft.length === 0);
  const editorRef = useRef<SourceNoteEditorHandle>(null);

  useEffect(() => {
    if (editing) editorRef.current?.focusAtEnd();
  }, [editing]);

  if (!editing && props.note.draft.trim()) {
    return <NotePreview value={props.note.draft} onEdit={() => setEditing(true)} />;
  }
  return (
    <SourceNoteEditor
      editorRef={editorRef}
      value={props.note.draft}
      onChange={props.note.change}
      onBlur={() => {
        void props.note.flush();
        if (props.note.draft.trim()) setEditing(false);
      }}
    />
  );
}

interface QuickNoteResizeSession {
  pointerId: number;
  popup: HTMLElement;
  positioner: HTMLElement | null;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  latestX: number;
  latestY: number;
  frameId: number | null;
  previousPositionerTransition: string;
  previousPopupWillChange: string;
}

const QUICK_NOTE_MIN_WIDTH = 288;
const QUICK_NOTE_MIN_HEIGHT = 176;
const QUICK_NOTE_MAX_WIDTH = 512;
const QUICK_NOTE_MAX_HEIGHT = 448;

function resizeQuickNote(popup: HTMLElement, width: number, height: number): void {
  const maxWidth = Math.min(QUICK_NOTE_MAX_WIDTH, window.innerWidth - 24);
  const maxHeight = Math.min(QUICK_NOTE_MAX_HEIGHT, window.innerHeight - 24);
  popup.style.width = `${Math.max(QUICK_NOTE_MIN_WIDTH, Math.min(width, maxWidth))}px`;
  popup.style.height = `${Math.max(QUICK_NOTE_MIN_HEIGHT, Math.min(height, maxHeight))}px`;
}

function applyQuickNoteResize(session: QuickNoteResizeSession): void {
  resizeQuickNote(
    session.popup,
    session.startWidth + session.latestX - session.startX,
    session.startHeight + session.latestY - session.startY,
  );
}

function queueQuickNoteResize(
  session: QuickNoteResizeSession,
  clientX: number,
  clientY: number,
): void {
  session.latestX = clientX;
  session.latestY = clientY;
  if (session.frameId !== null) return;
  session.frameId = window.requestAnimationFrame(() => {
    session.frameId = null;
    applyQuickNoteResize(session);
  });
}

function restoreQuickNoteResizeSession(session: QuickNoteResizeSession): void {
  if (session.frameId !== null) {
    window.cancelAnimationFrame(session.frameId);
    session.frameId = null;
    applyQuickNoteResize(session);
  }
  session.popup.style.willChange = session.previousPopupWillChange;
  if (session.positioner) {
    session.positioner.style.transition = session.previousPositionerTransition;
  }
}

function QuickNoteResizeHandle() {
  const sessionRef = useRef<QuickNoteResizeSession | null>(null);

  const popupFromTarget = (target: HTMLElement) =>
    target.closest<HTMLElement>('[data-slot="popover-popup"]');
  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    session.latestX = event.clientX;
    session.latestY = event.clientY;
    sessionRef.current = null;
    restoreQuickNoteResizeSession(session);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      role="button"
      aria-label="Resize quick note"
      tabIndex={0}
      className="absolute end-0 bottom-0 z-10 size-8 cursor-nwse-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onPointerDown={(event) => {
        const popup = popupFromTarget(event.currentTarget);
        if (!popup) return;
        const bounds = popup.getBoundingClientRect();
        const positioner = popup.closest<HTMLElement>('[data-slot="popover-positioner"]');
        sessionRef.current = {
          pointerId: event.pointerId,
          popup,
          positioner,
          startX: event.clientX,
          startY: event.clientY,
          startWidth: bounds.width,
          startHeight: bounds.height,
          latestX: event.clientX,
          latestY: event.clientY,
          frameId: null,
          previousPositionerTransition: positioner?.style.transition ?? "",
          previousPopupWillChange: popup.style.willChange,
        };
        popup.style.willChange = "width, height";
        if (positioner) positioner.style.transition = "none";
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        const coalescedEvents = event.nativeEvent.getCoalescedEvents();
        const latestEvent = coalescedEvents[coalescedEvents.length - 1] ?? event.nativeEvent;
        queueQuickNoteResize(session, latestEvent.clientX, latestEvent.clientY);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const popup = popupFromTarget(event.currentTarget);
        if (!popup || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          return;
        }
        const bounds = popup.getBoundingClientRect();
        const step = event.shiftKey ? 32 : 8;
        resizeQuickNote(
          popup,
          bounds.width +
            (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
          bounds.height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
        );
        event.preventDefault();
      }}
    >
      <span className="pointer-events-none absolute end-1.5 bottom-2 h-px w-3 -rotate-45 bg-muted-foreground" />
      <span className="pointer-events-none absolute end-1.5 bottom-1.5 h-px w-2 -rotate-45 bg-muted-foreground" />
    </div>
  );
}

export function useSourceNoteControls(props: {
  readonly record: ScientSourceDetailResult;
  readonly onSave: (
    note: string | null,
    expectedRevision: number,
  ) => Promise<ScientSourceNoteUpdateResult>;
}) {
  const note = useSourceNoteState(props);
  const quickNoteEditorRef = useRef<SourceNoteEditorHandle>(null);
  const [quickNoteOpen, setQuickNoteOpen] = useState(false);
  const [activeFormats, setActiveFormats] = useState<SourceNoteFormats>(EMPTY_SOURCE_NOTE_FORMATS);

  const handleFormatChange = useCallback((formats: SourceNoteFormats) => {
    setActiveFormats((current) =>
      current.bold === formats.bold && current.italic === formats.italic ? current : formats,
    );
  }, []);

  const applyFormat = (format: Extract<TextFormatType, "bold" | "italic">) => {
    quickNoteEditorRef.current?.format(format);
  };

  return {
    button: (
      <Popover open={quickNoteOpen} onOpenChange={setQuickNoteOpen}>
        <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
          <StickyNote />
          Note
        </PopoverTrigger>
        <PopoverPopup
          side="bottom"
          align="end"
          className="h-52 w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden"
          style={{ transitionProperty: "scale, opacity" }}
          viewportClassName="min-h-0 overflow-hidden p-2 [&>[data-current]]:flex [&>[data-current]]:h-full [&>[data-current]]:min-h-0 [&>[data-current]]:flex-col [&>[data-current]]:gap-2"
        >
          <div className="grid grid-cols-[1fr_auto_1fr] items-center px-1">
            <p className="text-sm font-medium">Quick note</p>
            <div className="flex items-center gap-px">
              <ScientTooltip content="Bold">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={cn(
                    "size-[22px]",
                    activeFormats.bold && "bg-accent text-accent-foreground",
                  )}
                  aria-label="Bold"
                  aria-pressed={activeFormats.bold}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyFormat("bold")}
                >
                  <span className="text-xs font-black leading-none" aria-hidden="true">
                    B
                  </span>
                </Button>
              </ScientTooltip>
              <ScientTooltip content="Italic">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className={cn(
                    "size-[22px]",
                    activeFormats.italic && "bg-accent text-accent-foreground",
                  )}
                  aria-label="Italic"
                  aria-pressed={activeFormats.italic}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyFormat("italic")}
                >
                  <span className="text-xs font-semibold italic leading-none" aria-hidden="true">
                    I
                  </span>
                </Button>
              </ScientTooltip>
            </div>
            <ScientTooltip content="Close quick note">
              <PopoverClose
                className="justify-self-end"
                render={<Button size="icon-xs" variant="ghost" aria-label="Close quick note" />}
              >
                <X />
              </PopoverClose>
            </ScientTooltip>
          </div>
          <SourceNoteEditor
            autoFocus
            fillAvailableSpace
            editorRef={quickNoteEditorRef}
            value={note.draft}
            onChange={note.change}
            onFormatChange={handleFormatChange}
            onBlur={() => void note.flush()}
          />
          <div className="pe-6">
            <NoteStatusLine status={note.status} error={note.error} />
          </div>
          <QuickNoteResizeHandle />
        </PopoverPopup>
      </Popover>
    ),
    section: (
      <section className="space-y-1.5" aria-labelledby="source-note-heading">
        <h3 id="source-note-heading" className="text-sm font-medium text-foreground">
          Notes
        </h3>
        <InlineNoteEditor note={note} />
        <NoteStatusLine status={note.status} error={note.error} />
      </section>
    ),
  } as const;
}
