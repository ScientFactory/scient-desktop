import type { CSSProperties, KeyboardEvent, Ref } from "react";

const SEGMENT_CLASS =
  "flex h-7 cursor-pointer items-center whitespace-nowrap px-2.5 font-medium text-sm outline-none hover:bg-accent focus-visible:bg-accent sm:text-xs";

/** Ask in chat and Ask in side chat, for a selection whose conversation offers both. */
export function CitationActionPill({
  ref,
  ...props
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly style: CSSProperties;
  readonly ownerId?: string | undefined;
  readonly pdf?: boolean;
  readonly onAskInChat: () => void;
  readonly onAskInSideChat: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={ref}
      role="group"
      aria-label="Ask about this selection"
      data-writing-menu-owner={props.ownerId}
      data-pdf-ask-in-chat={props.pdf ? "" : undefined}
      className="surface-glass fixed z-50 flex max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border/60 text-foreground shadow-sm"
      style={props.style}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={props.onKeyDown}
    >
      <button type="button" className={SEGMENT_CLASS} onClick={props.onAskInChat}>
        Ask in chat
      </button>
      <span aria-hidden className="w-px shrink-0 bg-border/60" />
      <button type="button" className={SEGMENT_CLASS} onClick={props.onAskInSideChat}>
        Ask in side chat
      </button>
    </div>
  );
}

/** Moves focus from a selection to its action: the button, or the pill's first choice. */
export function focusCitationAction(action: HTMLElement) {
  const target = action.matches("button") ? action : action.querySelector("button");
  target?.focus({ preventScroll: true });
}
