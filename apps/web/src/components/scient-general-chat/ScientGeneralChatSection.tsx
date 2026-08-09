import { ChevronDownIcon, MessageCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export const SCIENT_GENERAL_CHAT_DEFAULT_EXPANDED = false;
export const SCIENT_GENERAL_CHAT_ACCENT_CLASS =
  "text-[color:color-mix(in_srgb,var(--scient-burgundy)_60%,var(--sidebar-muted-foreground))] dark:text-[color:color-mix(in_srgb,var(--scient-warm-white)_60%,var(--sidebar-muted-foreground))]";

export function ScientGeneralChatIcon(props: { readonly className?: string }) {
  return (
    <MessageCircleIcon
      aria-hidden
      className={cn(props.className, SCIENT_GENERAL_CHAT_ACCENT_CLASS)}
    />
  );
}

/**
 * Scient-owned navigation for conversations that have not been placed in a
 * project. It deliberately accepts rows as children so T3 continues to own
 * thread rendering, selection, context menus, and lifecycle behavior.
 */
export function ScientGeneralChatSection(props: {
  readonly expanded: boolean;
  readonly itemCount: number;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      <section aria-label="General chat" data-testid="scient-general-chat-section">
        <button
          type="button"
          aria-expanded={props.expanded}
          aria-controls="scient-general-chat-list"
          onClick={props.onToggle}
          className={cn(
            "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            SCIENT_GENERAL_CHAT_ACCENT_CLASS,
          )}
        >
          <ScientGeneralChatIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">General chat</span>
          {props.itemCount > 0 ? (
            <span className="text-[11px] tabular-nums text-sidebar-muted-foreground/65">
              {props.itemCount}
            </span>
          ) : null}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-sidebar-muted-foreground transition-transform",
              props.expanded && "rotate-180",
            )}
          />
        </button>
        {props.expanded ? (
          <ul
            id="scient-general-chat-list"
            aria-label="General chats"
            className="mt-0.5 flex max-h-40 flex-col gap-px overflow-y-auto overscroll-contain"
          >
            {props.children}
          </ul>
        ) : null}
      </section>
      <div
        aria-hidden
        data-testid="scient-general-chat-divider"
        className="mx-2.5 mb-1 mt-3.5 h-px bg-sidebar-border/60"
      />
    </>
  );
}
