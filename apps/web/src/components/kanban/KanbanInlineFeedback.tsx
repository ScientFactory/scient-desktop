// FILE: KanbanInlineFeedback.tsx
// Purpose: Compact, local feedback for kanban boards and dialogs.
// Layer: Kanban UI primitive
// Exports: KanbanInlineFeedback, KanbanFeedback

import { Button } from "~/components/ui/button";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export type KanbanFeedbackTone = "error" | "info" | "success" | "warning";

export interface KanbanFeedback {
  readonly tone: KanbanFeedbackTone;
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
}

const PRESENTATION_BY_TONE = {
  error: {
    icon: CircleAlertIcon,
    className: "text-destructive",
  },
  info: {
    icon: InfoIcon,
    className: "text-muted-foreground",
  },
  success: {
    icon: CircleCheckIcon,
    className: "text-success",
  },
  warning: {
    icon: TriangleAlertIcon,
    className: "text-warning",
  },
} as const;

export function KanbanInlineFeedback({
  feedback,
  className,
  onDismiss,
}: {
  feedback: KanbanFeedback;
  className?: string | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const presentation = PRESENTATION_BY_TONE[feedback.tone];
  const Icon = presentation.icon;
  const role = feedback.tone === "error" ? "alert" : "status";

  return (
    <div
      role={role}
      aria-live={role === "alert" ? "assertive" : "polite"}
      className={cn(
        "flex min-w-0 items-start gap-2 text-xs leading-relaxed",
        presentation.className,
        className,
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{feedback.title}</span>
        {feedback.description ? (
          <span className="text-muted-foreground"> — {feedback.description}</span>
        ) : null}
      </p>
      {feedback.action ? (
        <Button type="button" size="xs" variant="ghost" onClick={feedback.action.onClick}>
          {feedback.action.label}
        </Button>
      ) : null}
      {onDismiss ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="-mt-1 -mr-1 shrink-0 text-muted-foreground/70 hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss message"
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  );
}
