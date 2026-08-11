import { ChevronDownIcon, MessageCircleIcon, PlusIcon } from "lucide-react";
import { SCIENT_GENERAL_CHAT_LABEL } from "@t3tools/client-runtime/scient/general-chat";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ScientGeneralChatIcon(props: { readonly className?: string }) {
  return (
    <MessageCircleIcon
      aria-hidden
      className={cn(props.className, "text-[var(--sidebar-icon-color)]")}
    />
  );
}

/**
 * Scient-owned navigation for conversations that have not been placed in a
 * project. It deliberately accepts rows as children so the generic thread row
 * stays shared while Scient owns the section, policy, and disclosure state.
 */
export function ScientGeneralChatSection(props: {
  readonly expanded: boolean;
  readonly itemCount: number;
  readonly onToggle: () => void;
  readonly onCreate: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      <section aria-label={SCIENT_GENERAL_CHAT_LABEL} data-testid="scient-general-chat-section">
        <div className="flex h-8 w-full items-center gap-1">
          <button
            type="button"
            aria-expanded={props.expanded}
            aria-controls="scient-general-chat-list"
            onClick={props.onToggle}
            className={cn(
              "group/scient-general-chat flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-[var(--sidebar-control-gap)] rounded-[var(--control-radius)] px-[var(--sidebar-row-content-inset)] text-left text-sm font-medium text-sidebar-muted-foreground/80 transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            )}
          >
            <ScientGeneralChatIcon className="size-4 shrink-0 group-hover/scient-general-chat:text-sidebar-foreground" />
            <span className="min-w-0 flex-1 truncate">{SCIENT_GENERAL_CHAT_LABEL}</span>
            {props.itemCount > 0 ? (
              <span className="text-[11px] tabular-nums text-sidebar-muted-foreground/65">
                {props.itemCount}
              </span>
            ) : null}
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "-mr-px size-4 shrink-0 text-[var(--sidebar-icon-color)] transition-[color,transform] group-hover/scient-general-chat:text-sidebar-foreground",
                props.expanded && "rotate-180",
              )}
            />
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New chat without a project"
                  className="relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[var(--control-radius)] font-medium text-sidebar-muted-foreground/80 outline-none transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground"
                  onClick={props.onCreate}
                />
              }
            >
              <PlusIcon className="size-4" />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
              />
            </TooltipTrigger>
            <TooltipPopup side="right">New chat without a project</TooltipPopup>
          </Tooltip>
        </div>
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
