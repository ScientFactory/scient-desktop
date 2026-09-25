import { isFileCitation, type ComposerCitation } from "@t3tools/contracts";
import { serializeComposerCitation } from "@t3tools/shared/composerCitations";
import {
  fileCitationHash,
  fileCitationNavigation,
} from "~/scient/markdownEditor/fileCitationNavigation";
import { basenameOfPath } from "~/pierre-icons";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
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
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";

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
  };
}) {
  const navigate = useNavigate();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
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
  const preview = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  const excerpt = preview.length > 64 ? `${preview.slice(0, 64)}…` : preview;
  const label = isFileCitation(citation)
    ? `${basenameOfPath(citation.path)} · ${excerpt}`
    : excerpt;
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
      title={
        isFileCitation(citation)
          ? `${citation.path} · within lines ${citation.startLine}–${citation.endLine}${citation.origin === "draft" ? " · unsaved at capture" : ""}\n${citation.text}`
          : undefined
      }
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
      title={
        isFileCitation(citation)
          ? `${citation.path} · within lines ${citation.startLine}–${citation.endLine}${citation.origin === "draft" ? " · unsaved at capture" : ""}\n${citation.text}`
          : undefined
      }
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
    </Link>
  );
  return (
    <ContextChip
      kind="citation"
      contentEditable={false}
      data-assistant-citation-chip={isFileCitation(citation) ? undefined : "true"}
      data-file-citation-chip={isFileCitation(citation) ? "true" : undefined}
      data-markdown-copy={serializeComposerCitation(citation)}
    >
      {composer ? (
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
