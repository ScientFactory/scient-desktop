import { CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

export type ScientMarkdownSaveStatusKind =
  | "conflict"
  | "failed"
  | "loading"
  | "saved"
  | "saving"
  | "unsaved";

const LABELS: Readonly<Record<ScientMarkdownSaveStatusKind, string>> = {
  conflict: "Conflict",
  failed: "Save failed",
  loading: "Loading",
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved",
};

const SLOW_SAVE_LABEL_DELAY_MS = 3_000;

function DelayedSavingLabel() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => setVisible(true), SLOW_SAVE_LABEL_DELAY_MS);
    return () => globalThis.clearTimeout(timeout);
  }, []);

  return visible ? (
    <span
      className="inline-flex shrink-0 items-center text-[10px] text-muted-foreground"
      data-scient-markdown-visible-save-status="saving"
      aria-hidden="true"
    >
      Saving…
    </span>
  ) : null;
}

export function ScientMarkdownSaveStatus(props: { readonly status: ScientMarkdownSaveStatusKind }) {
  const label = LABELS[props.status];
  const needsAttention =
    props.status === "conflict" || props.status === "failed" || props.status === "unsaved";

  return (
    <>
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`Markdown status: ${label}`}
        data-scient-markdown-save-status={props.status}
      >
        {label}
      </span>
      {props.status === "saving" ? <DelayedSavingLabel /> : null}
      {needsAttention ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground",
            (props.status === "conflict" || props.status === "failed") && "text-destructive",
          )}
          data-scient-markdown-visible-save-status={props.status}
          aria-hidden="true"
        >
          <CircleAlert className="size-3" />
          <span>{label}</span>
        </span>
      ) : null}
    </>
  );
}
