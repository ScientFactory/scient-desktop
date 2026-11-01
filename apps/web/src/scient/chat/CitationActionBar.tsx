import type { CSSProperties, KeyboardEvent, Ref } from "react";

import { cn } from "~/lib/utils";

const SEGMENT_CLASS =
  "flex h-7 cursor-pointer items-center whitespace-nowrap px-2.5 font-medium text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent aria-disabled:cursor-default aria-disabled:hover:bg-transparent sm:text-xs";

/** What a selection can do: Ask in chat, and Ask in side chat where the conversation has them. */
export function CitationActionBar({
  ref,
  ...props
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly style: CSSProperties;
  /** Places the bar inside a surface, for an action that belongs to it. */
  readonly className?: string;
  readonly ownerId?: string | undefined;
  readonly pdf?: boolean;
  /** Replaces "Ask in chat" when the selection cannot be asked about. */
  readonly label?: string;
  readonly accessibleLabel?: string;
  readonly disabled?: boolean;
  /** Stays focusable, unlike `disabled`, so the label is read out, not skipped. */
  readonly refused?: boolean;
  readonly onAskInChat: () => void;
  readonly onAskInSideChat?: (() => void) | undefined;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const label = props.label ?? "Ask in chat";
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Ask about this selection"
      data-writing-menu-owner={props.ownerId}
      data-pdf-ask-in-chat={props.pdf ? "" : undefined}
      className={cn(
        "surface-glass fixed z-50 flex max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border/60 text-foreground shadow-sm",
        props.className,
      )}
      style={props.style}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={props.onKeyDown}
    >
      <button
        type="button"
        className={SEGMENT_CLASS}
        disabled={props.disabled}
        aria-disabled={props.refused || undefined}
        aria-label={props.accessibleLabel ?? label}
        onClick={props.onAskInChat}
      >
        <span aria-live="polite">{label}</span>
      </button>
      {props.onAskInSideChat ? (
        <>
          <span aria-hidden className="w-px shrink-0 bg-border/60" />
          <button type="button" className={SEGMENT_CLASS} onClick={props.onAskInSideChat}>
            Ask in side chat
          </button>
        </>
      ) : null}
    </div>
  );
}
