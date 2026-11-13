import { ChevronLeft, Library, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";

export function SourceErrorBanner(props: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="m-3 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <span className="min-w-0 flex-1">{props.message}</span>
      <Button
        size="icon-xs"
        variant="ghost-destructive"
        className="shrink-0"
        aria-label="Dismiss source notification"
        onClick={props.onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}

export function PanelHeader(props: {
  readonly title: ReactNode;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly onBack?: () => void;
}) {
  return (
    <div className="@container flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5">
      {props.onBack ? (
        <Button variant="ghost" size="icon-sm" onClick={props.onBack} aria-label="Go back">
          <ChevronLeft />
        </Button>
      ) : (
        <Library className="size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{props.title}</div>
        {props.description ? (
          <div className="truncate text-xs text-muted-foreground">{props.description}</div>
        ) : null}
      </div>
      {props.action}
    </div>
  );
}

export function CenteredState(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-3 text-muted-foreground [&_svg]:size-6">{props.icon}</div>
        <h2 className="text-base font-medium">{props.title}</h2>
        {props.description ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{props.description}</p>
        ) : null}
        {props.action ? <div className="mt-4">{props.action}</div> : null}
      </div>
    </div>
  );
}
