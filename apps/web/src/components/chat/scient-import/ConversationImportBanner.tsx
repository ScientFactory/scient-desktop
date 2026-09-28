import type {
  OrchestrationConversationImport,
  OrchestrationConversationImportOmission,
  OrchestrationThread,
} from "@t3tools/contracts";
import { ImportIcon } from "lucide-react";

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
        ? "Imported from Markdown — unverified"
        : "Imported — unverified",
    description: [
      document
        ? "The original document is attached to this conversation."
        : markdown
          ? "Text copied from a Scient Markdown export, which anyone can edit."
          : "Copied from a Scient conversation file, which anyone can edit.",
      omitted.length > 0 ? `Not included: ${listLabels(omitted)}.` : null,
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
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-2xs text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <ImportIcon aria-hidden className="size-3" />
        <span>{document ? "Document attached" : "Imported · unverified"}</span>
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
 */
export function conversationImportBannerItem(
  thread: Pick<OrchestrationThread, "id" | "conversationImport" | "session"> | undefined,
  onDismiss: () => void,
): ComposerBannerStackItem | null {
  const conversationImport = thread?.conversationImport ?? null;
  if (thread === undefined || conversationImport === null || thread.session !== null) return null;
  return {
    id: `conversation-import:${thread.id}`,
    variant: "info",
    icon: <ImportIcon />,
    ...conversationImportNotice(conversationImport),
    dismissLabel: "Dismiss import notice",
    onDismiss,
  };
}
