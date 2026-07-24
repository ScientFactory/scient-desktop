// FILE: SidebarThreadTrailingIndicators.tsx
// Purpose: Render keyboard-jump hints and durable thread status together in sidebar rows.
// Layer: Sidebar UI component

import { CheckCircle2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { sidebarHoverRevealHideClassName } from "~/sidebarRowStyles";

import type { ThreadStatusPill } from "./Sidebar.logic";
import { SIDEBAR_TRAILING_ICON_CLASS } from "./sidebarGlyphs";
import { ThreadRunningSpinner } from "./ThreadRunningSpinner";
import { Kbd, KbdGroup } from "./ui/kbd";

const THREAD_ROW_INDICATOR_HOVER_FADE_CLASS_NAME = cn(
  "flex shrink-0 items-center",
  sidebarHoverRevealHideClassName("thread-row"),
);

function threadStatusSlotClassName(isSubagentThread: boolean, toneClassName?: string): string {
  return cn(
    "flex shrink-0 items-center justify-end leading-none tabular-nums",
    sidebarHoverRevealHideClassName("thread-row"),
    isSubagentThread
      ? "w-[1.2rem] text-[10px]"
      : "w-[1.625rem] text-[length:calc(var(--app-font-size-ui-meta,11px)+0.5px)]",
    toneClassName ?? (isSubagentThread ? "text-muted-foreground/26" : "text-muted-foreground/38"),
  );
}

export function SidebarStatusTrailingGlyph({ status }: { status: ThreadStatusPill }) {
  if (status.label === "Completed") {
    return (
      <CheckCircle2Icon
        aria-hidden="true"
        className={cn(SIDEBAR_TRAILING_ICON_CLASS, status.colorClass)}
      />
    );
  }
  if (status.pulse) {
    return <ThreadRunningSpinner />;
  }
  return (
    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)} />
  );
}

export function SidebarThreadTrailingIndicators({
  isSubagentThread,
  threadJumpLabel,
  threadJumpLabelParts,
  threadStatus,
  statusToneClassName,
}: {
  isSubagentThread: boolean;
  threadJumpLabel: string | null;
  threadJumpLabelParts: readonly string[];
  threadStatus: ThreadStatusPill | null;
  statusToneClassName?: string | undefined;
}) {
  return (
    <>
      {threadJumpLabel ? (
        <KbdGroup
          aria-label={`Jump to thread: ${threadJumpLabel}`}
          className={THREAD_ROW_INDICATOR_HOVER_FADE_CLASS_NAME}
        >
          {threadJumpLabelParts.map((part) => (
            <Kbd key={part}>{part}</Kbd>
          ))}
        </KbdGroup>
      ) : null}
      {threadStatus ? (
        <span
          aria-label={`Thread status: ${threadStatus.label}`}
          title={threadStatus.label}
          className={threadStatusSlotClassName(isSubagentThread, statusToneClassName)}
        >
          <SidebarStatusTrailingGlyph status={threadStatus} />
        </span>
      ) : null}
    </>
  );
}
