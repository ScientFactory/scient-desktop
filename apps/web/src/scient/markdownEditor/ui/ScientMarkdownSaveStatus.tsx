import { Check, CircleAlert, LoaderCircle } from "lucide-react";

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

export function ScientMarkdownSaveStatus(props: { readonly status: ScientMarkdownSaveStatusKind }) {
  const label = LABELS[props.status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground",
        (props.status === "conflict" || props.status === "failed") && "text-destructive",
      )}
      role="status"
      aria-live="polite"
      aria-label={`Markdown status: ${label}`}
      data-scient-markdown-save-status={props.status}
    >
      {props.status === "saving" || props.status === "loading" ? (
        <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
      ) : props.status === "saved" ? (
        <Check className="size-3" aria-hidden="true" />
      ) : (
        <CircleAlert className="size-3" aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  );
}
