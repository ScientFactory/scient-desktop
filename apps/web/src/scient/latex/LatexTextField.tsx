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
import { installLatexTextSelectionSession } from "./latexTextSelectionSession";

export const LatexDraftContext = createContext({
  reportDraft: (_id: string, _pending: boolean) => {},
  undo: (_redo: boolean) => {},
});

/** Apply an accepted grouped edit without publishing each field separately. */
export function replaceLatexFieldDraft(field: HTMLElement, value: string): void {
  field.dispatchEvent(new CustomEvent("scient-latex-replace-field-draft", { detail: value }));
}

type Props = Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string, fieldId?: string) => void;
  commitOn?: "idle" | "blur";
  /** An extra delete press in an empty field returns to its owning object. */
  onRemoveEmpty?: (direction: -1 | 1) => void;
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
  commitOn = "idle",
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onRemoveEmpty,
  ...props
}: Props) {
  const [draft, setDraft] = useState(() => restoredLatexFieldDraft(draftKey, value));
  const previousValue = useRef(value);
  const pending = useRef(draft === value ? null : { key: draftKey, base: value, text: draft });
  const composing = useRef(false);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelJournal = useRef<(() => void) | null>(null);
  const publish = useRef(onValueChange);
  useLayoutEffect(() => {
    publish.current = onValueChange;
  }, [onValueChange]);
  useEffect(() => () => clearTimeout(publishTimer.current), []);
  const owner = useRef({ key: draftKey, value });
  useLayoutEffect(() => {
    owner.current = { key: draftKey, value };
  }, [draftKey, value]);
  const publishPending = () => {
    const entry = pending.current;
    if (
      !entry ||
      composing.current ||
      entry.key !== owner.current.key ||
      entry.base !== owner.current.value
    )
      return;
    if (commitOn === "blur") publish.current(entry.text, id);
    else publish.current(entry.text);
  };
  const schedule = () => {
    clearTimeout(publishTimer.current);
    if (commitOn === "idle") publishTimer.current = setTimeout(publishPending, 180);
  };
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = field.current;
    if (!element?.closest(".scient-latex-visual-document")) return;
    return installLatexTextSelectionSession(element);
  }, []);
  const id = useId();
  const { reportDraft, undo } = useContext(LatexDraftContext);
  useEffect(() => {
    const element = field.current;
    const replace = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      clearTimeout(publishTimer.current);
      cancelJournal.current?.();
      cancelJournal.current = null;
      composing.current = false;
      pending.current = null;
      // The replaced text is no longer unfinished input: without this the
      // document stays "editing" and cannot be saved, built or exported.
      reportDraft(id, false);
      setDraft(event.detail);
      if (element) element.value = event.detail;
      if (draftKey) {
        try {
          localStorage.removeItem(`scient.latex.field:${draftKey}`);
        } catch {
          /* Optional journal. */
        }
      }
    };
    element?.addEventListener("scient-latex-replace-field-draft", replace);
    return () => element?.removeEventListener("scient-latex-replace-field-draft", replace);
  }, [draftKey, id, reportDraft]);
  useEffect(() => {
    const persist = () => {
      cancelJournal.current?.();
      cancelJournal.current = null;
      const entry = pending.current;
      if (!entry?.key) return;
      try {
        localStorage.setItem(
          `scient.latex.field:${entry.key}`,
          JSON.stringify({ base: entry.base, text: entry.text }),
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
  }, []);
  useLayoutEffect(() => {
    reportDraft(id, pending.current !== null || composing.current);
  }, [id, reportDraft]);
  useEffect(() => () => reportDraft(id, false), [id, reportDraft]);
  useLayoutEffect(() => {
    if (
      pending.current !== null &&
      pending.current.key === draftKey &&
      value === pending.current.text &&
      draft === value &&
      !composing.current
    ) {
      pending.current = null;
      reportDraft(id, false);
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
  }, [draft, draftKey, value, id, reportDraft]);
  const retain = (text: string) => {
    const entry = pending.current ?? { key: draftKey, base: value, text };
    pending.current =
      !composing.current && entry.key === draftKey && entry.base === value && text === value
        ? null
        : { ...entry, text };
    if (pending.current === null && draftKey) {
      try {
        localStorage.removeItem(`scient.latex.field:${draftKey}`);
      } catch {
        /* Optional journal. */
      }
    }
    reportDraft(id, pending.current !== null || composing.current);
    setDraft(text);
    if (draftKey) {
      cancelJournal.current?.();
      cancelJournal.current = afterEditorPaint(() => {
        cancelJournal.current = null;
        const entry = pending.current;
        if (!entry?.key) return;
        try {
          localStorage.setItem(
            `scient.latex.field:${entry.key}`,
            JSON.stringify({ base: entry.base, text: entry.text }),
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
      data-empty={draft.trim() === "" || undefined}
      data-local-draft={draft !== value || undefined}
      onKeyDown={(event) => {
        if (
          onRemoveEmpty &&
          !props.disabled &&
          !event.nativeEvent.isComposing &&
          !composing.current &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey &&
          (event.key === "Backspace" || event.key === "Delete") &&
          event.currentTarget.value.trim() === ""
        ) {
          event.preventDefault();
          event.stopPropagation();
          replaceLatexFieldDraft(event.currentTarget, "");
          onRemoveEmpty(event.key === "Backspace" ? -1 : 1);
          return;
        }
        if (commitOn === "blur" && event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          publishPending();
          return;
        }
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
        if (!composing.current) schedule();
      }}
      onCompositionStart={(event) => {
        composing.current = true;
        reportDraft(id, true);
        clearTimeout(publishTimer.current);
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        retain(event.currentTarget.value);
        schedule();
        onCompositionEnd?.(event);
      }}
      onBlur={(event) => {
        clearTimeout(publishTimer.current);
        publishPending();
        onBlur?.(event);
      }}
    />
  );
}
