import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useEnvironments } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";

import { useCloudAccount } from "./useCloudAccount";
import { useCloudStatus } from "./useCloudStatus";
import { useContinueHere } from "./useContinueHere";

/**
 * The banner on a conversation another of the person's computers continued. This computer
 * refuses new turns on it; "Take it back" continues the latest copy here.
 */
export function useCloudMovedBanner(
  thread: { readonly id: string; readonly environmentId: EnvironmentId } | null,
): ComposerBannerStackItem | null {
  const { status } = useCloudStatus(thread === null ? null : thread.environmentId);
  const { environments } = useEnvironments();
  const moved =
    thread === null
      ? undefined
      : status?.movedThreads.find((entry) => entry.threadId === thread.id);
  if (thread === null || moved === undefined) return null;
  const label =
    environments.find((environment) => environment.environmentId === moved.movedTo)?.label ??
    "another computer";
  return {
    id: "scient-cloud-moved",
    variant: "info",
    icon: <CloudIcon />,
    title: `Continued on ${label}`,
    description: "New messages go to that computer now. This conversation stays as it was here.",
    ...(hasCloudPublicConfig()
      ? { actions: <TakeBackButton environmentId={thread.environmentId} threadId={thread.id} /> }
      : {}),
  };
}

function TakeBackButton({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: string;
}) {
  const { api } = useCloudAccount();
  const continueHere = useContinueHere(api);
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(problem ?? continueHere.problem) ? (
        <span className="text-xs text-muted-foreground">{problem ?? continueHere.problem}</span>
      ) : null}
      {continueHere.chooser}
      <Button
        size="xs"
        variant="outline"
        disabled={continueHere.running}
        onClick={async () => {
          setProblem(null);
          const threads = await api.threads().catch(() => null);
          const continuation = threads?.find(
            (row) =>
              row.continuedFrom?.env === environmentId && row.continuedFrom.thread === threadId,
          );
          if (continuation === undefined) {
            setProblem("The other computer hasn't copied it yet. Try again in a minute.");
            return;
          }
          const imported = await continueHere.run(continuation, environmentId);
          if (imported === null) return;
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({ environmentId, threadId: ThreadId.make(imported) }),
          });
        }}
      >
        {continueHere.running ? "Taking it back…" : "Take it back"}
      </Button>
    </div>
  );
}
