import { isFileCitation, type ComposerCitation } from "@t3tools/contracts";
import { serializeComposerCitation } from "@t3tools/shared/composerCitations";
import {
  fileCitationHash,
  fileCitationNavigation,
} from "~/scient/markdownEditor/fileCitationNavigation";
import { basenameOfPath } from "~/pierre-icons";
import { Link, useNavigate } from "@tanstack/react-router";
import { PencilIcon, QuoteIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type MouseEvent as ReactMouseEvent } from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import { cn } from "~/lib/utils";
import {
  assistantCitationHash,
  assistantCitationNavigation,
} from "../../lib/assistantCitationNavigation";
import {
  CHAT_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES,
} from "../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";

const CITATION_ACTION_BUTTON_CLASS_NAME = cn(
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  "text-current hover:bg-[color-mix(in_oklab,var(--context-chip-accent)_17%,transparent)] hover:text-current",
);

export function CitationChip({
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
    sourceAnchor?: AssistantCitationSourceAnchor | undefined;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onSave: (comment: string) => boolean;
    onSaveAndSend?: (comment: string) => boolean;
  };
}) {
  const navigate = useNavigate();
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const onSourceUnavailable = useEffectEvent(() => {
    if (sourceAnchor) commentEditor?.onOpenChange(false);
  });
  useEffect(() => {
    if (!commentOpen) return;
    const anchor =
      sourceAnchor ??
      (isFileCitation(citation) ? null : findAssistantCitationSourceAnchor(document, citation));
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation: isFileCitation(citation) ? undefined : citation,
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor]);
  // A multi-line selection's bounding box spans the full message width; anchor
  // the bubble to the selection's last line, where the pointer released.
  const popupAnchor = sourceAnchor
    ? {
        contextElement: sourceAnchor.source,
        getBoundingClientRect: () => {
          const rects = sourceAnchor.range.getClientRects();
          return rects.item(rects.length - 1) ?? sourceAnchor.range.getBoundingClientRect();
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
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline focus-visible:outline-2 focus-visible:outline-[var(--contrast-foreground)]"
      aria-label={`View cited ${isFileCitation(citation) ? citation.path : "assistant text"}: ${label}`}
      title={
        isFileCitation(citation)
          ? `${citation.path} · within lines ${citation.startLine}–${citation.endLine}${citation.origin === "draft" ? " · unsaved at capture" : ""}\n${citation.text}`
          : undefined
      }
    >
      <QuoteIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "max-w-[16em]")}>{label}</span>
    </Link>
  );
  const chatSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline hover:bg-[color-mix(in_oklab,var(--context-chip-accent)_17%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--contrast-foreground)]"
      aria-label={`View cited ${isFileCitation(citation) ? citation.path : "assistant text"}: ${label}`}
      title={
        isFileCitation(citation)
          ? `${citation.path} · within lines ${citation.startLine}–${citation.endLine}${citation.origin === "draft" ? " · unsaved at capture" : ""}\n${citation.text}`
          : undefined
      }
    >
      <QuoteIcon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
      <span className={cn(COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME, "max-w-[16em]")}>{label}</span>
    </Link>
  );
  return (
    <span
      className={cn(
        composer ? COMPOSER_INLINE_CHIP_CLASS_NAME : CHAT_INLINE_CHIP_CLASS_NAME,
        CONTEXT_INLINE_CHIP_TONE_CLASS_NAMES.citation,
      )}
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
        <Popover open={commentEditor.open} onOpenChange={commentEditor.onOpenChange}>
          <PopoverTrigger
            aria-label={citation.comment ? "Edit citation comment" : "Add comment to citation"}
            className={CITATION_ACTION_BUTTON_CLASS_NAME}
          >
            <PencilIcon aria-hidden="true" className="size-[0.85em]" />
          </PopoverTrigger>
          {commentEditor.open ? (
            <PopoverPopup
              {...composerFloatingLayerProps}
              side={sourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor}
              initialFocus={() => {
                commentInputRef.current?.focus({ preventScroll: true });
                return false;
              }}
              aria-label="Edit citation comment"
              className="w-72 max-w-[calc(100vw-1rem)]"
              viewportClassName="p-3"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <AssistantCitationCommentEditor
                key={serializeComposerCitation(citation)}
                citation={citation}
                inputRef={commentInputRef}
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
        <button
          type="button"
          onClick={onRemove}
          aria-label={
            isFileCitation(citation) ? "Remove file citation" : "Remove assistant citation"
          }
          className={CITATION_ACTION_BUTTON_CLASS_NAME}
        >
          <XIcon aria-hidden="true" className="size-[0.85em]" />
        </button>
      ) : null}
    </span>
  );
}
