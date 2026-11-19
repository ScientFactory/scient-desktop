import type {
  OrchestrationConversationImport,
  OrchestrationConversationImportOmission,
  OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { importTimesShiftedNotice } from "@scientfactory/conversation";
import { msg, T, useMessages, Var } from "gt-react";
import { ImportIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { ComposerBanner } from "../ComposerBanner";
import type { ComposerBannerStackItem } from "../ComposerBannerStack";
import { m, type MessageResolver } from "../../../i18n/messages";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

/** One item of the "Not included: …" list. */
function omissionLabel(
  omission: OrchestrationConversationImportOmission,
  resolve: MessageResolver,
): string {
  switch (omission._tag) {
    case "work-log-excluded":
      return resolve(
        msg("the work log", { $context: "item in a list of what an import left out" }),
      );
    case "reasoning-excluded":
      return resolve(msg("reasoning", { $context: "item in a list of what an import left out" }));
    case "range-truncated":
      return resolve(
        msg("messages after message {number}", {
          number: omission.throughMessageN,
          $context: "item in a list of what an import left out",
        }),
      );
    case "running-turn-omitted":
      return resolve(
        msg("a turn that was still running", {
          $context: "item in a list of what an import left out",
        }),
      );
    case "attachments-unavailable":
      return resolve(
        msg(
          "{count, plural, one {{count} unavailable attachment} other {{count} unavailable attachments}}",
          { count: omission.count, $context: "item in a list of what an import left out" },
        ),
      );
    case "records-skipped":
      return resolve(
        msg(
          "{count, plural, one {{count} unsupported record} other {{count} unsupported records}}",
          { count: omission.count, $context: "item in a list of what an import left out" },
        ),
      );
  }
}

function listLabels(labels: ReadonlyArray<string>, resolve: MessageResolver): string {
  if (labels.length <= 1) return labels.join("");
  return resolve(
    msg("{items} and {last}", {
      items: labels.slice(0, -1).join(", "),
      last: labels.at(-1),
      $context: "joins the last item of a list",
    }),
  );
}

/** What the import banner says about an imported thread. */
export function conversationImportNotice(
  conversationImport: OrchestrationConversationImport,
  sessionStarted = false,
  takenOver = false,
  resolve: MessageResolver = m,
): {
  readonly title: string;
  readonly description: string;
} {
  const markdown = conversationImport.source === "markdown";
  const document = conversationImport.sourceFormat === "scient-markdown-document";
  const omitted = conversationImport.omissions.map((omission) => omissionLabel(omission, resolve));
  return {
    title: document
      ? resolve(msg("Started with a Markdown document"))
      : markdown
        ? resolve(msg("Imported from Markdown (unverified)"))
        : resolve(msg("Imported (unverified)")),
    description: [
      document
        ? resolve(msg("The original document is attached to this conversation."))
        : takenOver
          ? resolve(
              msg(
                "Continued from that computer; files stay where they are. The conversation there stays as it was.",
              ),
            )
          : markdown
            ? resolve(msg("Text copied from a Scient Markdown export, which anyone can edit."))
            : resolve(msg("Copied from a Scient conversation file, which anyone can edit.")),
      omitted.length > 0
        ? resolve(msg("Not included: {list}.", { list: listLabels(omitted, resolve) }))
        : null,
      // The file's own notes, which the server keeps only when no omission says the same.
      ...new Set(conversationImport.notices ?? []),
      conversationImport.timesShiftedMs === undefined
        ? null
        : importTimesShiftedNotice(conversationImport.timesShiftedMs),
      sessionStarted
        ? document
          ? resolve(
              msg(
                "The attached document remains unverified after the new provider session starts.",
              ),
            )
          : resolve(
              msg("The imported history remains unverified after the new provider session starts."),
            )
        : resolve(
            msg(
              "Your next message starts a fresh session; the agent receives this history as context.",
            ),
          ),
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
  const messages = useMessages();
  if (!conversationImport) return null;
  const notice = conversationImportNotice(conversationImport, sessionStarted, false, messages);
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
        <span>
          {document ? messages(msg("Document attached")) : messages(msg("Imported (unverified)"))}
        </span>
        {!document && conversationImport.omissions.length > 0 ? (
          <span>
            ·{" "}
            {messages(
              msg("{count, plural, one {{count} omission} other {{count} omissions}}", {
                count: conversationImport.omissions.length,
              }),
            )}
          </span>
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
  resolve: MessageResolver = m,
): ComposerBannerStackItem | null {
  const conversationImport = thread?.conversationImport ?? null;
  if (thread == null || conversationImport === null || thread.activeProviderThreadId !== null)
    return null;
  const notice = conversationImportNotice(
    conversationImport,
    false,
    continuedFrom !== null,
    resolve,
  );
  return {
    id: `conversation-import:${thread.id}`,
    variant: "info",
    icon: <ImportIcon />,
    dismissLabel: resolve(msg("Dismiss import notice")),
    onDismiss,
    ...(continuedFrom === null
      ? { title: notice.title, description: notice.description }
      : {
          title: (
            <T>
              Continued from <Var>{continuedFrom}</Var>
            </T>
          ),
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
  const messages = useMessages();
  const [dismissedImportNoticeThreadId, setDismissedImportNoticeThreadId] = useState<string | null>(
    null,
  );
  return thread == null || dismissedImportNoticeThreadId === thread.id
    ? null
    : conversationImportBannerItem(
        thread.source,
        () => setDismissedImportNoticeThreadId(thread.id),
        continuedFrom,
        messages,
      );
}
