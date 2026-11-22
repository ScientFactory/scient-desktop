import { msg, T, useGT, useMessages } from "gt-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { ComposerBannerText } from "~/components/chat/scient-import/ConversationImportBanner";
import { Button } from "~/components/ui/button";
import { useEnvironments } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";

import { hasCloudAccount, useCloudAccount } from "./useCloudAccount";
import { useCloudList } from "./useCloudList";
import { useCloudStatus } from "./useCloudStatus";
import { CLOUD_COPY_NEEDED, useContinueHere } from "./useContinueHere";
import { m } from "~/i18n/messages";

/**
 * Cloud facts about the open conversation: the banner when another of the person's computers
 * continued it (this computer refuses new turns; "Take it back" continues the latest copy here),
 * and the computer it was continued from, for the import banner.
 */
export function useCloudThreadBanner(
  thread: { readonly id: string; readonly environmentId: EnvironmentId } | null,
): { readonly moved: ComposerBannerStackItem | null; readonly continuedFrom: ReactNode } {
  const { status } = useCloudStatus(thread === null ? null : thread.environmentId);
  const continued =
    thread === null
      ? undefined
      : status?.continuedThreads.find((entry) => entry.threadId === thread.id);
  const continuedFrom =
    continued === undefined ? null : <ComputerName environmentId={continued.from.environmentId} />;
  const moved =
    thread === null
      ? undefined
      : status?.movedThreads.find((entry) => entry.threadId === thread.id);
  if (thread === null || moved === undefined) return { moved: null, continuedFrom };
  const canTakeBack = hasCloudAccount();
  return {
    continuedFrom,
    moved: {
      id: "scient-cloud-moved",
      variant: "info",
      icon: <CloudIcon />,
      title: (
        <T>
          Continued on <ComputerName environmentId={moved.movedTo} />
        </T>
      ),
      children: (
        <ComposerBannerText>
          {canTakeBack ? (
            <T>
              New messages go to that computer now. This conversation stays here as it was and takes
              no new messages. Take it back to continue its latest copy here, as a new conversation.
            </T>
          ) : (
            <T>
              New messages go to that computer now. This conversation stays here as it was and takes
              no new messages.
            </T>
          )}
        </ComposerBannerText>
      ),
      ...(canTakeBack
        ? { actions: <TakeBackButton environmentId={thread.environmentId} threadId={thread.id} /> }
        : {}),
    },
  };
}

/** A computer's name: a connected environment's label, else its name in Scient Cloud. */
function ComputerName({ environmentId }: { environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const gt = useGT();
  const label = environments.find(
    (environment) => environment.environmentId === environmentId,
  )?.label;
  if (label !== undefined) return label;
  return hasCloudAccount() ? (
    <CloudComputerName environmentId={environmentId} />
  ) : (
    gt("another computer")
  );
}

function CloudComputerName({ environmentId }: { environmentId: EnvironmentId }) {
  const { api, userId } = useCloudAccount();
  const { items } = useCloudList(
    () => (userId === null ? Promise.resolve([]) : api.computers()),
    `computers:${userId}`,
  );
  const gt = useGT();
  return (
    items?.find((computer) => computer.environmentId === environmentId)?.label ??
    gt("another computer")
  );
}

function TakeBackButton({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  const account = useCloudAccount();
  const { api } = account;
  const continueHere = useContinueHere(account);
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const gt = useGT();
  const messages = useMessages();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(problem ?? continueHere.problem) ? (
        <span className="text-xs text-muted-foreground">{problem ?? continueHere.problem}</span>
      ) : continueHere.needsCloudCopy ? (
        <span className="text-xs text-muted-foreground">{messages(CLOUD_COPY_NEEDED)}</span>
      ) : null}
      {continueHere.chooser}
      <Button
        size="xs"
        variant="outline"
        disabled={continueHere.running}
        onClick={async () => {
          setProblem(null);
          const imported = await continueHere.runFound(
            `${environmentId}/${threadId}`,
            async () => {
              const threads = await api.threads().catch(() => null);
              const continuation = threads?.find(
                (row) =>
                  row.continuedFrom?.env === environmentId && row.continuedFrom.thread === threadId,
              );
              if (continuation !== undefined) return continuation;
              setProblem(m(msg("The other computer hasn't synced it yet. Try again in a minute.")));
              return null;
            },
            environmentId,
            continueHere.needsCloudCopy,
          );
          if (imported === null) return;
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({ environmentId, threadId: ThreadId.make(imported) }),
          });
        }}
      >
        {continueHere.running
          ? gt("Taking it back…")
          : continueHere.needsCloudCopy
            ? gt("Turn on sync and take it back")
            : gt("Take it back")}
      </Button>
    </div>
  );
}
