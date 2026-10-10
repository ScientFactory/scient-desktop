import { isFileCitation, type ComposerCitation, type FileCitation } from "@t3tools/contracts";
import {
  composerCitationLabel,
  serializeComposerCitation,
} from "@t3tools/shared/composerCitations";
import {
  fileCitationHash,
  fileCitationNavigation,
} from "~/scient/markdownEditor/fileCitationNavigation";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { PencilIcon, QuoteIcon, XIcon } from "lucide-react";
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
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { observeResize } from "~/lib/observeResize";

export function AssistantCitationChip({
  citation,
  composer = false,
  onRemove,
  commentEditor,
}: {
  citation: ComposerCitation;
  onRemove?: () => void;
  composer?: boolean;
  commentEditor?: {
    open: boolean;
    mode?: "create" | "edit";
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
    const anchor =
      sourceAnchor ??
      (isFileCitation(citation) ? null : findAssistantCitationSourceAnchor(document, citation));
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation: isFileCitation(citation) ? undefined : citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  // A multi-line selection's bounding box spans the full message width; anchor
  // the bubble to the selection's last line, where the pointer released.
  const popupAnchor = activeSourceAnchor
    ? {
        contextElement: activeSourceAnchor.source,
        getBoundingClientRect: () => {
          const rects = activeSourceAnchor.range.getClientRects();
          return rects.item(rects.length - 1) ?? activeSourceAnchor.range.getBoundingClientRect();
        },
      }
    : undefined;
  const label = composerCitationLabel(citation);
  const sourceLinkProps = {
    to: "/$environmentId/$threadId" as const,
    params: { environmentId: citation.environmentId, threadId: citation.threadId },
    hash: isFileCitation(citation) ? fileCitationHash(citation) : assistantCitationHash(citation),
    "data-markdown-copy": serializeComposerCitation(citation),
    resetScroll: false,
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      if (isFileCitation(citation)) {
        void navigate(fileCitationNavigation(citation));
      } else void navigate(assistantCitationNavigation(citation));
    },
  };
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline focus-visible:outline-2 focus-visible:outline-foreground"
      aria-label={`View cited ${isFileCitation(citation) ? citation.path : "assistant text"}: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
    </Link>
  );
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
    return (
      <ContextChipPopover
        kind="citation"
        icon={<QuoteIcon />}
        label={label}
        accessibleLabel={`Quoted assistant text: ${label}`}
        copyMarkdown={serializeComposerCitation(citation)}
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
      data-assistant-citation-chip={isFileCitation(citation) ? undefined : "true"}
      data-file-citation-chip={isFileCitation(citation) ? "true" : undefined}
      data-markdown-copy={serializeComposerCitation(citation)}
    >
      {isFileCitation(citation) ? (
        <FileCitationHoverCard
          citation={citation}
          trigger={composer ? composerSourceLink : chatSourceLink}
        />
      ) : composer ? (
        composerSourceLink
      ) : (
        <Tooltip>
          <TooltipTrigger render={chatSourceLink} />
          <TooltipPopup side="top">View source</TooltipPopup>
        </Tooltip>
      )}
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
              aria-label={
                commentEditor.mode === "create" ? "Add citation to chat" : "Edit citation comment"
              }
              width="md"
              padding="compact"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                key={serializeComposerCitation(citation)}
                citation={citation}
                {...(commentEditor.mode ? { mode: commentEditor.mode } : {})}
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
    </ContextChip>
  );
}

/**
 * Compact hover card for a file citation: the filename stands out, the directory
 * wraps at path separators onto a few short lines, and the cited range and
 * excerpt follow. Replaces the native `title`, which rendered deep absolute
 * paths as one unstyled line spanning the chat width.
 */
function FileCitationHoverCard({
  citation,
  trigger,
}: {
  citation: FileCitation;
  trigger: ReactElement;
}) {
  const separatorIndex = Math.max(citation.path.lastIndexOf("/"), citation.path.lastIndexOf("\\"));
  const fileName = citation.path.slice(separatorIndex + 1);
  const directory = separatorIndex > 0 ? citation.path.slice(0, separatorIndex + 1) : "";
  // Offer a break after every separator so long paths wrap between segments.
  const directorySegments = directory.split(/(?<=[\\/])/);
  const excerpt = citation.text.replace(/\s+/g, " ").trim();
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="top" className="max-w-72">
        <span className="flex min-w-0 flex-col gap-0.5 py-0.5 text-left">
          <span className="font-medium text-foreground">{fileName || citation.path}</span>
          {directory ? (
            <span className="line-clamp-3 font-mono text-2xs text-muted-foreground">
              {directorySegments.map((segment, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- segments are positional and static
                <Fragment key={index}>
                  {segment}
                  <wbr />
                </Fragment>
              ))}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            Lines {citation.startLine}–{citation.endLine}
            {citation.origin === "draft" ? " · unsaved at capture" : ""}
          </span>
          {excerpt ? (
            <span className="mt-0.5 line-clamp-2 border-l-2 border-border pl-1.5 text-muted-foreground">
              {excerpt}
            </span>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function AssistantCitationQuote({ citation }: { citation: ComposerCitation }) {
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
