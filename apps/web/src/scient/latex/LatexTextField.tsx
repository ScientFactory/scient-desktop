import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";
import { afterEditorPaint } from "./afterEditorPaint";

export const LatexDraftContext = createContext({
  reportDraft: (_id: string, _pending: boolean) => {},
  undo: (_redo: boolean) => {},
});

type Props = Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Scoped to a document and field; only unacknowledged input is journaled here. */
  draftKey?: string | undefined;
};

export function restoredLatexFieldDraft(key: string | undefined, value: string): string {
  if (!key) return value;
  try {
    const entry: unknown = JSON.parse(localStorage.getItem(`scient.latex.field:${key}`) ?? "null");
    if (
      entry &&
      typeof entry === "object" &&
      "base" in entry &&
      "text" in entry &&
      entry.base === value &&
      typeof entry.text === "string"
    )
      return entry.text;
  } catch {
    /* Storage is optional; live editing still works. */
  }
  return value;
}

/** The focused field owns exact text and composition. Source acknowledgements never replace it. */
export function LatexTextField({
  value,
  onValueChange,
  draftKey,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  ...props
}: Props) {
  const [draft, setDraft] = useState(() => restoredLatexFieldDraft(draftKey, value));
  const previousValue = useRef(value);
  const pending = useRef<string | null>(draft === value ? null : draft);
  const composing = useRef(false);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelJournal = useRef<(() => void) | null>(null);
  const publish = useRef(onValueChange);
  useLayoutEffect(() => {
    publish.current = onValueChange;
  }, [onValueChange]);
  useEffect(() => () => clearTimeout(publishTimer.current), []);
  const schedule = (text: string) => {
    clearTimeout(publishTimer.current);
    publishTimer.current = setTimeout(() => publish.current(text), 180);
  };
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const { reportDraft, undo } = useContext(LatexDraftContext);
  useEffect(() => {
    const persist = () => {
      cancelJournal.current?.();
      cancelJournal.current = null;
      if (!draftKey || pending.current === null) return;
      try {
        localStorage.setItem(
          `scient.latex.field:${draftKey}`,
          JSON.stringify({ base: previousValue.current, text: pending.current }),
        );
      } catch {
        /* Keep the live field if storage is unavailable. */
      }
    };
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, [draftKey]);
  useEffect(() => {
    reportDraft(id, draft !== value);
  }, [draft, value, id, reportDraft]);
  useEffect(() => () => reportDraft(id, false), [id, reportDraft]);
  useLayoutEffect(() => {
    if (value === pending.current && draft === value) {
      pending.current = null;
      if (draftKey) {
        try {
          localStorage.removeItem(`scient.latex.field:${draftKey}`);
        } catch {
          /* Optional journal. */
        }
      }
    } else if (previousValue.current !== value && pending.current === null && !composing.current) {
      const element = field.current;
      const focused = element === document.activeElement;
      const start = element?.selectionStart ?? 0;
      const end = element?.selectionEnd ?? start;
      setDraft(value);
      if (focused && element) {
        // An external change or Undo has new text; retain the nearest caret position.
        element.value = value;
        element.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
      }
    }
    previousValue.current = value;
  }, [draft, draftKey, value]);
  const retain = (text: string) => {
    pending.current = text;
    setDraft(text);
    if (draftKey) {
      cancelJournal.current?.();
      cancelJournal.current = afterEditorPaint(() => {
        cancelJournal.current = null;
        if (pending.current === null) return;
        try {
          localStorage.setItem(
            `scient.latex.field:${draftKey}`,
            JSON.stringify({ base: previousValue.current, text: pending.current }),
          );
        } catch {
          /* Keep the live draft if storage is full. */
        }
      });
    }
  };
  return (
    <textarea
      {...props}
      ref={field}
      value={draft}
      data-local-draft={draft !== value || undefined}
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if (
          !event.nativeEvent.isComposing &&
          (event.ctrlKey || event.metaKey) &&
          (key === "z" || key === "y")
        ) {
          event.stopPropagation();
          // Incomplete input still belongs to the native field's history.
          if (draft === value) {
            event.preventDefault();
            undo(key === "y" || event.shiftKey);
          }
          return;
        }
        onKeyDown?.(event);
      }}
      onChange={(event) => {
        const text = event.currentTarget.value;
        retain(text);
        if (!composing.current) schedule(text);
      }}
      onCompositionStart={(event) => {
        composing.current = true;
        clearTimeout(publishTimer.current);
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        retain(event.currentTarget.value);
        schedule(event.currentTarget.value);
        onCompositionEnd?.(event);
      }}
      onBlur={(event) => {
        composing.current = false;
        clearTimeout(publishTimer.current);
        if (pending.current !== null) onValueChange(event.currentTarget.value);
        onBlur?.(event);
      }}
    />
  );
}
