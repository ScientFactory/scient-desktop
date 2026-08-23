import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function AssistedSetupFrame(props: {
  readonly children: ReactNode;
  readonly flow: "claude" | "codex" | "droid" | "grok";
}) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "space-y-3 px-6 pb-4 in-[[data-model-picker-content=true]]:flex in-[[data-model-picker-content=true]]:min-h-full in-[[data-model-picker-content=true]]:w-full in-[[data-model-picker-content=true]]:flex-col in-[[data-model-picker-content=true]]:items-center in-[[data-model-picker-content=true]]:justify-center in-[[data-model-picker-content=true]]:gap-3 in-[[data-model-picker-content=true]]:space-y-0 in-[[data-model-picker-content=true]]:px-5 in-[[data-model-picker-content=true]]:py-4 in-[[data-model-picker-content=true]]:text-center in-[[data-slot=dialog-panel]]:p-0",
        props.flow === "grok" &&
          "in-[[data-model-picker-content=true]]:-translate-x-2.5 in-[[data-model-picker-content=true]]:-translate-y-2.5 in-[[data-model-picker-content=true]]:[&_[data-assisted-setup-icon=true]]:-translate-y-1 in-[[data-model-picker-content=true]]:[&_[data-assisted-setup-title=true]]:-translate-y-1",
      )}
      data-provider-onboarding-view={`${props.flow}-flow`}
    >
      {props.children}
    </div>
  );
}

export function AssistedSetupStatus(props: {
  readonly body: ReactNode;
  readonly icon: ReactNode;
  readonly trailing?: ReactNode;
  readonly title: ReactNode;
  readonly role?: "alert" | "status" | undefined;
}) {
  return (
    <div
      className="flex items-start gap-3 py-1 in-[[data-model-picker-content=true]]:flex-col in-[[data-model-picker-content=true]]:items-center in-[[data-model-picker-content=true]]:gap-2 in-[[data-model-picker-content=true]]:py-0 in-[[data-model-picker-content=true]]:text-center"
      role={props.role}
    >
      <span
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center in-[[data-model-picker-content=true]]:mt-0 in-[[data-model-picker-content=true]]:size-8 in-[[data-model-picker-content=true]]:[&>svg]:size-7"
        data-assisted-setup-icon="true"
        aria-hidden
      >
        {props.icon}
      </span>
      <div className="min-w-0 flex-1 in-[[data-model-picker-content=true]]:max-w-64 in-[[data-model-picker-content=true]]:flex-none">
        <p className="text-sm font-medium text-foreground" data-assisted-setup-title="true">
          {props.title}
        </p>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{props.body}</div>
      </div>
      {props.trailing ? (
        <div className="shrink-0 self-end in-[[data-model-picker-content=true]]:hidden">
          {props.trailing}
        </div>
      ) : null}
    </div>
  );
}

export function AssistedSetupActions(props: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 pt-1 in-[[data-model-picker-content=true]]:w-full in-[[data-model-picker-content=true]]:justify-center in-[[data-model-picker-content=true]]:pt-0",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}
