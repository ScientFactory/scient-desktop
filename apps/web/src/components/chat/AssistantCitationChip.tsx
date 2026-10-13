import type { AssistantCitation } from "@t3tools/contracts";
// SCIENT-FORK:START — quotes from Markdown files (scient-file-citation://) share this chip; its
// labels, copy text and navigation come from the composer-citation owners.
import { isFileCitation, type ComposerCitation } from "@t3tools/contracts";
import {
  composerCitationLabel,
  serializeComposerCitation,
} from "@t3tools/shared/composerCitations";
import {
  fileCitationHash,
  fileCitationNavigation,
} from "~/scient/markdownEditor/fileCitationNavigation";
import { FileCitationHoverCard } from "~/scient/markdownEditor/FileCitationHoverCard";
// SCIENT-FORK:END
import { Link, useNavigate } from "@tanstack/react-router";
// SCIENT-FORK:START — a composer chip can be removed.
import { ArrowUpRightIcon, PencilIcon, QuoteIcon, XIcon } from "lucide-react";
// SCIENT-FORK:END
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { observeResize } from "~/lib/observeResize";

export function AssistantCitationChip({
  citation,
  composer = false,
  // SCIENT-FORK:START — file quotes; a removable composer chip.
  onRemove,
  // SCIENT-FORK:END
  commentEditor,
}: {
  // SCIENT-FORK:START — file quotes; a removable composer chip.
  citation: ComposerCitation;
  onRemove?: () => void;
  // SCIENT-FORK:END
  composer?: boolean;
  commentEditor?: {
    open: boolean;
    // SCIENT-FORK:START — the Markdown editor creates a citation from the same popover.
    mode?: "create" | "edit";
    // SCIENT-FORK:END
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onSave: (comment: string) => boolean;
    onSaveAndSend?: (comment: string) => boolean;
    /** Returns focus to the host editor when the popover closes instead of to the pencil trigger. */
    onRestoreFocus?: () => void;
  };
}) {
  const navigate = useNavigate();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const activeSourceAnchor = sourceAnchor === unavailableSourceAnchor ? undefined : sourceAnchor;
  useEffect(() => {
    if (!commentOpen) draftCommentRef.current = null;
  }, [commentOpen]);
  const settleDraftOnClose = (reason: string): boolean => {
    const dismissal = resolveAssistantCitationCommentDismissal({
      reason,
      draft: draftCommentRef.current,
      savedComment: citation.comment,
    });
    if (dismissal.kind === "commit") return commentEditor?.onSave(dismissal.comment) ?? true;
    return dismissal.kind !== "keep-open";
  };
  const onSourceUnavailable = useEffectEvent(() => {
    if (!sourceAnchor) return;
    if (settleDraftOnClose("none")) {
      commentEditor?.onOpenChange(false);
    } else {
      // Keep the draft mounted, positioned at the composer trigger instead of a detached range.
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  useEffect(() => {
    if (!commentOpen || sourceAnchor === unavailableSourceAnchor) return;
    // SCIENT-FORK:START — a file quote has no assistant-message source to find.
    const anchor =
      sourceAnchor ??
      (isFileCitation(citation) ? null : findAssistantCitationSourceAnchor(document, citation));
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation: isFileCitation(citation) ? undefined : citation,
      // SCIENT-FORK:END
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  // A multi-line selection's bounding box spans the full message width; anchor
  // the bubble to the selection's last line, where the pointer released.
  const popupAnchor = activeSourceAnchor
    ? {
        contextElement: activeSourceAnchor.source,
        getBoundingClientRect: () => {
          // SCIENT-FORK:START — an editor selection can resolve its own line rects.
          const rects = activeSourceAnchor.resolveRects?.() ?? [
            ...activeSourceAnchor.range.getClientRects(),
          ];
          return rects.at(-1) ?? activeSourceAnchor.range.getBoundingClientRect();
          // SCIENT-FORK:END
        },
      }
    : undefined;
  // SCIENT-FORK:START — file quotes label, copy and link to their file.
  const label = composerCitationLabel(citation);
  // SCIENT-FORK:END
  const sourceLinkProps = {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    // SCIENT-FORK:START — file quotes label, copy and link to their file.
    hash: isFileCitation(citation) ? fileCitationHash(citation) : assistantCitationHash(citation),
    "data-markdown-copy": serializeComposerCitation(citation),
    // SCIENT-FORK:END
    resetScroll: false,
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      // SCIENT-FORK:START — a file quote opens its file at the quoted lines.
      if (isFileCitation(citation)) {
        void navigate(fileCitationNavigation(citation));
      } else void navigate(assistantCitationNavigation(citation));
      // SCIENT-FORK:END
    },
  };
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline focus-visible:outline-2 focus-visible:outline-foreground"
      // SCIENT-FORK:START — a file quote names its file.
      aria-label={`View cited ${isFileCitation(citation) ? citation.path : "assistant text"}: ${label}`}
      // SCIENT-FORK:END
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
    </Link>
  );
  // SCIENT-FORK:START — in chat, a file quote is a link chip with a hover card, not the popover.
  const chatSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline hover:bg-(--context-chip-accent)/17 focus-visible:outline-2 focus-visible:outline-foreground"
      aria-label={`View cited ${isFileCitation(citation) ? citation.path : "assistant text"}: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
    </Link>
  );
  if (!composer && !isFileCitation(citation)) {
    // SCIENT-FORK:END
    return (
      <ContextChipPopover
        kind="citation"
        icon={<QuoteIcon />}
        label={label}
        accessibleLabel={`Quoted assistant text: ${label}`}
        // SCIENT-FORK:START — the composer-citation owner serializes both kinds.
        copyMarkdown={serializeComposerCitation(citation)}
        // SCIENT-FORK:END
      >
        <div className="flex max-h-[calc(var(--available-height)_-_1rem_-_2px)] flex-col items-start gap-3 p-1 text-sm">
          <AssistantCitationQuote citation={citation} />
          <PopoverClose
            render={<Button variant="outline" size="sm" render={<Link {...sourceLinkProps} />} />}
          >
            <ArrowUpRightIcon aria-hidden="true" />
            Go to source
          </PopoverClose>
        </div>
      </ContextChipPopover>
    );
  }
  return (
    <ContextChip
      kind="citation"
      contentEditable={false}
      // SCIENT-FORK:START — a file quote is marked as one and shows its hover card.
      data-assistant-citation-chip={isFileCitation(citation) ? undefined : "true"}
      data-file-citation-chip={isFileCitation(citation) ? "true" : undefined}
      data-markdown-copy={serializeComposerCitation(citation)}
    >
      {isFileCitation(citation) ? (
        <FileCitationHoverCard
          citation={citation}
          trigger={composer ? composerSourceLink : chatSourceLink}
        />
      ) : (
        composerSourceLink
      )}
      {/* SCIENT-FORK:END */}
      {commentEditor ? (
        <Popover
          open={commentEditor.open}
          onOpenChange={(open, eventDetails) => {
            if (!open && !settleDraftOnClose(eventDetails.reason)) {
              eventDetails.cancel();
              return;
            }
            commentEditor.onOpenChange(open);
          }}
        >
          <PopoverTrigger
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            data-citation-comment-trigger="true"
            render={<ContextChipAction />}
          >
            <PencilIcon aria-hidden="true" />
          </PopoverTrigger>
          {commentEditor.open ? (
            <PopoverPopup
              {...composerFloatingLayerProps}
              // SCIENT-FORK:START — the editor's writing menu stays with its selection.
              data-writing-menu-owner={activeSourceAnchor?.selectionOwnerId}
              // SCIENT-FORK:END
              side={activeSourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor}
              initialFocus={() => {
                commentInputRef.current?.focus({ preventScroll: true });
                return false;
              }}
              finalFocus={
                commentEditor.onRestoreFocus
                  ? () => {
                      // Leave focus alone when the user closed the popover by moving to another control.
                      const activeElement = document.activeElement;
                      if (
                        activeElement === document.body ||
                        (activeElement !== null && commentPopupRef.current?.contains(activeElement))
                      ) {
                        commentEditor.onRestoreFocus?.();
                      }
                      return false;
                    }
                  : undefined
              }
              ref={commentPopupRef}
              // SCIENT-FORK:START — the Markdown editor creates a citation from the same popover.
              aria-label={
                commentEditor.mode === "create" ? "Add citation to chat" : "Edit citation comment"
              }
              // SCIENT-FORK:END
              width="md"
              padding="compact"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                // SCIENT-FORK:START — file quotes; the editor's create mode.
                key={serializeComposerCitation(citation)}
                citation={citation}
                {...(commentEditor.mode ? { mode: commentEditor.mode } : {})}
                // SCIENT-FORK:END
                inputRef={commentInputRef}
                onDraftChange={(comment) => {
                  draftCommentRef.current = comment;
                }}
                onSubmit={(comment) => {
                  if (!commentEditor.onSave(comment)) return false;
                  commentEditor.onOpenChange(false);
                  return true;
                }}
                {...(commentEditor.onSaveAndSend
                  ? {
                      onSubmitAndSend: (comment: string) => {
                        if (!commentEditor.onSaveAndSend?.(comment)) return false;
                        commentEditor.onOpenChange(false);
                        return true;
                      },
                    }
                  : {})}
                onCancel={() => {
                  if (commentEditor.onCancel) {
                    commentEditor.onCancel();
                  } else {
                    commentEditor.onOpenChange(false);
                  }
                }}
              />
            </PopoverPopup>
          ) : null}
        </Popover>
      ) : null}
      {/* SCIENT-FORK:START — a composer chip can be removed. */}
      {onRemove ? (
        <ContextChipAction
          onClick={onRemove}
          aria-label={
            isFileCitation(citation) ? "Remove file citation" : "Remove assistant citation"
          }
        >
          <XIcon aria-hidden="true" className="size-[0.85em]" />
        </ContextChipAction>
      ) : null}
      {/* SCIENT-FORK:END */}
    </ContextChip>
  );
}

function AssistantCitationQuote({ citation }: { citation: AssistantCitation }) {
  const [fade, setFade] = useState({ top: false, bottom: false });
  const updateFade = useCallback((element: HTMLElement) => {
    const top = element.scrollTop > 1;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop > 1;
    setFade((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  }, []);
  // Stable so a fade update during resize delivery does not resubscribe the element.
  const observeFade = useCallback(
    (element: HTMLDivElement | null) =>
      element ? observeResize(element, () => updateFade(element)) : undefined,
    [updateFade],
  );
  return (
    <div
      ref={observeFade}
      onScroll={(event) => updateFade(event.currentTarget)}
      className={cn(
        "max-h-64 min-h-0 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap wrap-break-word",
        getVirtualizedScrollFadeClassName(fade),
      )}
    >
      <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
        {citation.text}
      </blockquote>
      {citation.comment ? <p>{citation.comment}</p> : null}
    </div>
  );
}
