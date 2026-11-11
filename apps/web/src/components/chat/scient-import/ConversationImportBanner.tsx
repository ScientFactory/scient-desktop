import type {
  OrchestrationConversationImport,
  OrchestrationConversationImportOmission,
  OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { importTimesShiftedNotice } from "@scientfactory/conversation";
import { ImportIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { ComposerBanner } from "../ComposerBanner";
import type { ComposerBannerStackItem } from "../ComposerBannerStack";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function omissionLabel(omission: OrchestrationConversationImportOmission): string {
  switch (omission._tag) {
    case "work-log-excluded":
      return "the work log";
    case "reasoning-excluded":
      return "reasoning";
    case "range-truncated":
      return `messages after message ${omission.throughMessageN}`;
    case "running-turn-omitted":
      return "a turn that was still running";
    case "attachments-unavailable":
      return plural(omission.count, "unavailable attachment", "unavailable attachments");
    case "records-skipped":
      return plural(omission.count, "unsupported record", "unsupported records");
  }
}

function listLabels(labels: ReadonlyArray<string>): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** What the import banner says about an imported thread. */
export function conversationImportNotice(
  conversationImport: OrchestrationConversationImport,
  sessionStarted = false,
  takenOver = false,
): {
  readonly title: string;
  readonly description: string;
} {
  const markdown = conversationImport.source === "markdown";
  const document = conversationImport.sourceFormat === "scient-markdown-document";
  const omitted = conversationImport.omissions.map(omissionLabel);
  return {
    title: document
      ? "Started with a Markdown document"
      : markdown
        ? "Imported from Markdown (unverified)"
        : "Imported (unverified)",
    description: [
      document
        ? "The original document is attached to this conversation."
        : takenOver
          ? "Continued from that computer; files stay where they are. The conversation there stays as it was."
          : markdown
            ? "Text copied from a Scient Markdown export, which anyone can edit."
            : "Copied from a Scient conversation file, which anyone can edit.",
      omitted.length > 0 ? `Not included: ${listLabels(omitted)}.` : null,
      // The file's own notes, which the server keeps only when no omission says the same.
      ...new Set(conversationImport.notices ?? []),
      conversationImport.timesShiftedMs === undefined
        ? null
        : importTimesShiftedNotice(conversationImport.timesShiftedMs),
      sessionStarted
        ? document
          ? "The attached document remains unverified after the new provider session starts."
          : "The imported history remains unverified after the new provider session starts."
        : "Your next message starts a fresh session; the agent receives this history as context.",
    ]
      .filter((line) => line !== null)
      .join(" "),
  };
}

/** A non-dismissable provenance marker that remains visible after continuation. */
export function ConversationImportProvenanceBadge({
  conversationImport,
  sessionStarted,
}: {
  readonly conversationImport: OrchestrationConversationImport | null | undefined;
  readonly sessionStarted: boolean;
}) {
  if (!conversationImport) return null;
  const notice = conversationImportNotice(conversationImport, sessionStarted);
  const document = conversationImport.sourceFormat === "scient-markdown-document";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            data-conversation-import-provenance={document ? "document" : "unverified"}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <ImportIcon aria-hidden className="size-3" />
        <span>{document ? "Document attached" : "Imported (unverified)"}</span>
        {!document && conversationImport.omissions.length > 0 ? (
          <span>· {plural(conversationImport.omissions.length, "omission", "omissions")}</span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-80">
        {notice.description}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The composer notice on an imported thread until its first provider session
 * starts, when "the next message starts a fresh session" stops being true.
 * `continuedFrom` names the computer a take-over continued it from.
 */
export function conversationImportBannerItem(
  thread:
    | Pick<OrchestrationV2AppThread, "id" | "conversationImport" | "activeProviderThreadId">
    | null
    | undefined,
  onDismiss: () => void,
  continuedFrom: ReactNode = null,
): ComposerBannerStackItem | null {
  const conversationImport = thread?.conversationImport ?? null;
  if (thread == null || conversationImport === null || thread.activeProviderThreadId !== null)
    return null;
  const notice = conversationImportNotice(conversationImport, false, continuedFrom !== null);
  return {
    id: `conversation-import:${thread.id}`,
    variant: "info",
    icon: <ImportIcon />,
    dismissLabel: "Dismiss import notice",
    onDismiss,
    ...(continuedFrom === null
      ? { title: notice.title, description: notice.description }
      : {
          title: <>Continued from {continuedFrom}</>,
          children: <ComposerBannerText>{notice.description}</ComposerBannerText>,
        }),
  };
}

/** A banner's explanation in full, wrapped under its title, where the row would cut it off. */
export function ComposerBannerText({ children }: { readonly children: ReactNode }) {
  return (
    <ComposerBanner.Body className="pe-2 pb-1.5 text-muted-foreground">
      {children}
    </ComposerBanner.Body>
  );
}

/** The open thread's import notice, until the reader dismisses it on that thread. */
export function useConversationImportBanner(
  thread: {
    readonly id: string;
    readonly source: NonNullable<Parameters<typeof conversationImportBannerItem>[0]>;
  } | null,
  continuedFrom: ReactNode = null,
): ComposerBannerStackItem | null {
  const [dismissedImportNoticeThreadId, setDismissedImportNoticeThreadId] = useState<string | null>(
    null,
  );
  return thread == null || dismissedImportNoticeThreadId === thread.id
    ? null
    : conversationImportBannerItem(
        thread.source,
        () => setDismissedImportNoticeThreadId(thread.id),
        continuedFrom,
      );
}
