import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AssistantCitation, ResponseContextRecord } from "@t3tools/contracts";
import {
  assistantCitationLabel,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
// SCIENT-FORK:START — quotes from Markdown files (scient-file-citation://) share this chip; its
// labels, copy text and navigation come from the composer-citation owners.
import {
  isComputeCitation,
  isFileCitation,
  isOfficeCitation,
  isPdfCitation,
  type ComposerCitation,
} from "@t3tools/contracts";
import {
  composerCitationLabel,
  serializeComposerCitation,
} from "@t3tools/shared/composerCitations";
import { computeCitationPlaceLabel } from "@t3tools/shared/computeCitations";
import { ComputeCitationHoverCard } from "~/scient/compute/ComputeCitationHoverCard";
import {
  computeCitationHash,
  computeCitationNavigation,
} from "~/scient/compute/computeCitationNavigation";
import {
  fileCitationHash,
  fileCitationNavigation,
} from "~/scient/markdownEditor/fileCitationNavigation";
import { FileCitationHoverCard } from "~/scient/markdownEditor/FileCitationHoverCard";
import { PdfCitationHoverCard } from "~/scient/pdf/anchors/PdfCitationHoverCard";
import { pdfCitationHash, pdfCitationNavigation } from "~/scient/pdf/anchors/pdfCitationNavigation";
import { pdfCitationDocumentLabel } from "@t3tools/shared/pdfCitations";
import { officeCitationPlaceLabel } from "@t3tools/shared/officeCitations";
import {
  OfficeCitationHoverCard,
  officeCitationHash,
  officeCitationNavigation,
} from "~/scient/office/officeQuote";
// SCIENT-FORK:END
import { Link, useNavigate } from "@tanstack/react-router";
// SCIENT-FORK:START — a composer chip can be removed.
import { PencilIcon, QuoteIcon, XIcon } from "lucide-react";
// SCIENT-FORK:END
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  findAssistantCitationSourceAnchor,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  assistantCitationNavigation,
  assistantCitationRoute,
} from "../../lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { useQuietThreadShell } from "~/state/entities";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";
import { resolveAssistantCitationCommentDismissal } from "./assistantCitationCommentDismissal";
import { observeAssistantCitationCommentSource } from "./AssistantCitationSource";
import { composerFloatingLayerProps } from "./composerEventScope";
import { textDirection } from "~/textDirection";

// SCIENT-FORK:START — a document quote (file, PDF, Compute, Office) names and opens its document.
/** A quote of a document rather than of an assistant response. */
export function isDocumentCitation(
  citation: ComposerCitation,
): citation is Exclude<ComposerCitation, AssistantCitation> {
  return (
    isFileCitation(citation) ||
    isPdfCitation(citation) ||
    isComputeCitation(citation) ||
    isOfficeCitation(citation)
  );
}
// SCIENT-FORK:END

// SCIENT-FORK:START — file quotes label, copy and link to their file.
function useCitationSourceLinkProps(citation: ComposerCitation) {
  // SCIENT-FORK:END
  const navigate = useNavigate();
  const sourceThread = useQuietThreadShell(
    scopeThreadRef(citation.environmentId, citation.threadId),
  );
  return {
    // SCIENT-FORK:START — file quotes label, copy and link to their file; an assistant quote
    // takes upstream's route, which opens a side chat quote on its parent thread.
    ...(isDocumentCitation(citation)
      ? {
          to: "/$environmentId/$threadId" as const,
          params: { environmentId: citation.environmentId, threadId: citation.threadId },
          hash: isPdfCitation(citation)
            ? pdfCitationHash(citation)
            : isComputeCitation(citation)
              ? computeCitationHash(citation)
              : isOfficeCitation(citation)
                ? officeCitationHash(citation)
                : fileCitationHash(citation),
          resetScroll: false,
        }
      : assistantCitationRoute(citation, sourceThread)),
    "data-markdown-copy": serializeComposerCitation(citation),
    // SCIENT-FORK:END
    onClick: (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      // SCIENT-FORK:START — a file quote opens its file at the quoted lines; a PDF quote its page;
      // a Compute quote its run or cell.
      if (isPdfCitation(citation)) {
        void navigate(pdfCitationNavigation(citation));
      } else if (isComputeCitation(citation)) {
        void navigate(computeCitationNavigation(citation));
      } else if (isOfficeCitation(citation)) {
        void navigate(officeCitationNavigation(citation));
      } else if (isFileCitation(citation)) {
        void navigate(fileCitationNavigation(citation));
      } else void navigate(assistantCitationNavigation(citation, sourceThread));
      // SCIENT-FORK:END
    },
  };
}

const flat = (text: string) => text.replace(/\s+/g, " ");

/**
 * The card a response shows as inside a message. Clicking it goes to the source; a comment follows
 * as text. `leading` and `trailing` say it starts or ends its block, which already has spacing.
 */
function ResponseCard({
  citation,
  copyMarkdown,
  cardCopyMarkdown = copyMarkdown,
  label,
  title,
  preview,
  comment,
  leading,
  trailing,
}: {
  citation: AssistantCitation;
  copyMarkdown: string;
  cardCopyMarkdown?: string;
  label: string;
  title?: string | undefined;
  preview: ReactNode;
  comment?: string | undefined;
  leading: boolean;
  trailing: boolean;
}) {
  const linkProps = useCitationSourceLinkProps(citation);
  return (
    // One copy boundary for the card and its comment, so a copied card carries the comment once.
    <span
      data-markdown-copy={copyMarkdown}
      className={cn("block", !leading && "mt-[0.65rem]", !trailing && "mb-[0.65rem]")}
    >
      <Link
        {...linkProps}
        // A selection inside the card's boundary copies the card here and the comment as text.
        data-markdown-copy={cardCopyMarkdown}
        // The response is findable in its own message; here it is clamped and mostly hidden.
        data-thread-find-ignore
        aria-label={label}
        // The message's markdown styles colour and underline links; a card is neither.
        className="block min-w-0 rounded-lg bg-black/10 px-2.5 py-1.5 text-start text-sm text-muted-foreground! no-underline! wrap-break-word hover:bg-black/14 focus-visible:outline-2 focus-visible:outline-ring dark:bg-black/35 dark:hover:bg-black/50"
      >
        {title ? (
          <span className="block truncate text-xs font-medium text-foreground/80" dir="auto">
            {title}
          </span>
        ) : null}
        <span className="line-clamp-2" dir={textDirection(citation.text)}>
          {preview}
        </span>
      </Link>
      {comment ? (
        <span className="mt-1.5 block whitespace-pre-wrap" dir={textDirection(comment)}>
          {comment}
        </span>
      ) : null}
    </span>
  );
}

/** A passage quoted from a response, with its surrounding context and the user's comment. */
export function AssistantCitationEmbed({
  citation,
  leading,
  trailing,
}: {
  citation: AssistantCitation;
  leading: boolean;
  trailing: boolean;
}) {
  const wholeResponse = citation.prefix === "" && citation.suffix === "";
  const { comment, ...quoted } = citation;
  return (
    <ResponseCard
      citation={citation}
      copyMarkdown={serializeAssistantCitation(citation)}
      cardCopyMarkdown={serializeAssistantCitation(quoted)}
      label={`Go to quoted response: ${assistantCitationLabel(quoted)}`}
      comment={comment}
      leading={leading}
      trailing={trailing}
      preview={
        wholeResponse ? (
          flat(citation.text)
        ) : (
          <>
            {citation.prefix ? `…${flat(citation.prefix)}` : null}
            <mark className="rounded-sm bg-foreground/12 px-0.5 text-foreground">
              {flat(citation.text)}
            </mark>
            {citation.suffix ? `${flat(citation.suffix)}…` : null}
          </>
        )
      }
    />
  );
}

/** The response a message replies to: its subagents, when it had any, and how it starts. */
export function ResponseReplyCard({
  record,
  copyMarkdown,
  leading,
  trailing,
}: {
  record: ResponseContextRecord;
  copyMarkdown: string;
  leading: boolean;
  trailing: boolean;
}) {
  return (
    <ResponseCard
      citation={record.citation}
      copyMarkdown={copyMarkdown}
      label={`Go to the response this replies to: ${record.label}`}
      title={record.subagents?.map((subagent) => subagent.title).join(", ")}
      preview={flat(record.citation.text)}
      leading={leading}
      trailing={trailing}
    />
  );
}

/** The citation chip in the composer, with its comment editor. */
export function AssistantCitationChip({
  citation,
  // SCIENT-FORK:START — file quotes; a removable composer chip; a sent message's document quote.
  onRemove,
  sentMessage = false,
  // SCIENT-FORK:END
  commentEditor,
}: {
  // SCIENT-FORK:START — file quotes; a removable composer chip; a sent message's document quote.
  citation: ComposerCitation;
  onRemove?: () => void;
  sentMessage?: boolean;
  // SCIENT-FORK:END
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
    onDraftChange?: (comment: string) => void;
    onRestoreFocus?: () => void;
  };
}) {
  const sourceLinkProps = useCitationSourceLinkProps(citation);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentPopupRef = useRef<HTMLDivElement>(null);
  const draftCommentRef = useRef<string | null>(null);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [unavailableSourceAnchor, setUnavailableSourceAnchor] =
    useState<AssistantCitationSourceAnchor | null>(null);
  const commentOpen = commentEditor?.open ?? false;
  const sourceAnchor = commentEditor?.sourceAnchor;
  const activeSourceAnchor = sourceAnchor === unavailableSourceAnchor ? undefined : sourceAnchor;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the uncommitted comment draft held in a ref once the parent closes the comment editor
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
      setUnavailableSourceAnchor(sourceAnchor);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the cited DOM source while the comment editor is open and reacts when it disappears
  useEffect(() => {
    if (!commentOpen || sourceAnchor === unavailableSourceAnchor) return;
    // SCIENT-FORK:START — a document quote has no assistant-message source to find.
    const assistantQuote =
      isFileCitation(citation) ||
      isPdfCitation(citation) ||
      isComputeCitation(citation) ||
      isOfficeCitation(citation)
        ? undefined
        : citation;
    const anchor =
      sourceAnchor ??
      (assistantQuote ? findAssistantCitationSourceAnchor(document, assistantQuote) : null);
    if (!anchor) return;
    return observeAssistantCitationCommentSource({
      anchor,
      citation: assistantQuote,
      // SCIENT-FORK:END
      onUnavailable: onSourceUnavailable,
    });
  }, [citation, commentOpen, sourceAnchor, unavailableSourceAnchor]);
  const popupAnchor = activeSourceAnchor
    ? {
        contextElement: activeSourceAnchor.source,
        getBoundingClientRect: () => {
          // SCIENT-FORK:START — retained selections resolve live source rectangles.
          const rects = activeSourceAnchor.resolveRects?.() ?? [
            ...activeSourceAnchor.range.getClientRects(),
          ];
          // SCIENT-FORK:END
          const rect = rects.at(-1) ?? activeSourceAnchor.range.getBoundingClientRect();
          // Code blocks and tables scroll sideways inside the message, so the cited
          // text can end in their hidden overflow. Base UI only shifts the popup while
          // it still touches the anchor, so clamp the anchor to the message's width.
          const bounds = activeSourceAnchor.source.getBoundingClientRect();
          const left = Math.min(Math.max(rect.left, bounds.left), bounds.right);
          const right = Math.max(Math.min(rect.right, bounds.right), left);
          return new DOMRect(left, rect.top, right - left, rect.height);
        },
      }
    : undefined;
  // SCIENT-FORK:START — file and PDF quotes label, copy and link to their document.
  const label = composerCitationLabel(citation);
  const documentQuote = isDocumentCitation(citation);
  const sourceName = isFileCitation(citation)
    ? citation.path
    : isPdfCitation(citation)
      ? pdfCitationDocumentLabel(citation)
      : isComputeCitation(citation)
        ? computeCitationPlaceLabel(citation)
        : isOfficeCitation(citation)
          ? officeCitationPlaceLabel(citation)
          : "assistant text";
  // SCIENT-FORK:END
  const composerSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex min-w-0 items-center gap-[0.2em] self-baseline text-inherit no-underline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current rounded-sm"
      // SCIENT-FORK:START — a file or PDF quote names its document.
      aria-label={`View cited ${sourceName}: ${label}`}
      // SCIENT-FORK:END
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]" dir={textDirection(label)}>
        {label}
      </ContextChipLabel>
    </Link>
  );
  // SCIENT-FORK:START — in a sent message, a document quote is a link chip with a hover card.
  const chatSourceLink = (
    <Link
      {...sourceLinkProps}
      className="inline-flex h-full min-w-0 items-center gap-[0.33em] rounded-sm text-inherit no-underline hover:bg-(--context-chip-accent)/17 focus-visible:outline-2 focus-visible:outline-foreground"
      aria-label={`View cited ${sourceName}: ${label}`}
    >
      <QuoteIcon aria-hidden="true" />
      <ContextChipLabel className="max-w-[16em]">{label}</ContextChipLabel>
    </Link>
  );
  const documentSourceLink = sentMessage ? chatSourceLink : composerSourceLink;
  // SCIENT-FORK:END
  return (
    <ContextChip
      kind="citation"
      contentEditable={false}
      // SCIENT-FORK:START — a file quote is marked as one and shows its hover card.
      data-assistant-citation-chip={documentQuote ? undefined : "true"}
      data-file-citation-chip={isFileCitation(citation) ? "true" : undefined}
      data-pdf-citation-chip={isPdfCitation(citation) ? "true" : undefined}
      data-compute-citation-chip={isComputeCitation(citation) ? "true" : undefined}
      data-markdown-copy={serializeComposerCitation(citation)}
    >
      {isFileCitation(citation) ? (
        <FileCitationHoverCard citation={citation} trigger={documentSourceLink} />
      ) : isPdfCitation(citation) ? (
        <PdfCitationHoverCard citation={citation} trigger={documentSourceLink} />
      ) : isComputeCitation(citation) ? (
        <ComputeCitationHoverCard citation={citation} trigger={documentSourceLink} />
      ) : isOfficeCitation(citation) ? (
        <OfficeCitationHoverCard citation={citation} trigger={documentSourceLink} />
      ) : (
        composerSourceLink
      )}
      {/* SCIENT-FORK:END */}
      {commentEditor ? (
        <Popover
          open={commentEditor.open && !voiceSetupOpen}
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
              // The editor stays mounted while its voice setup dialog replaces the popover.
              keepMounted
              {...composerFloatingLayerProps}
              // SCIENT-FORK:START — the editor's writing menu stays with its selection.
              data-writing-menu-owner={activeSourceAnchor?.selectionOwnerId}
              // SCIENT-FORK:END
              side={activeSourceAnchor ? "bottom" : "top"}
              align="end"
              anchor={popupAnchor}
              initialFocus={() => {
                const input = commentInputRef.current;
                if (input) {
                  input.focus({ preventScroll: true });
                  input.setSelectionRange(input.value.length, input.value.length);
                  // Moving the caret doesn't scroll a long comment to it.
                  input.scrollTop = input.scrollHeight;
                }
                return false;
              }}
              finalFocus={
                commentEditor.onRestoreFocus
                  ? () => {
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
                onVoiceSetupOpenChange={setVoiceSetupOpen}
                onDraftChange={(comment) => {
                  draftCommentRef.current = comment;
                  commentEditor.onDraftChange?.(comment);
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
            isPdfCitation(citation)
              ? "Remove PDF citation"
              : isComputeCitation(citation)
                ? "Remove Compute citation"
                : isOfficeCitation(citation)
                  ? "Remove Office citation"
                  : isFileCitation(citation)
                    ? "Remove file citation"
                    : "Remove assistant citation"
          }
        >
          <XIcon aria-hidden="true" className="size-[0.85em]" />
        </ContextChipAction>
      ) : null}
      {/* SCIENT-FORK:END */}
    </ContextChip>
  );
}
