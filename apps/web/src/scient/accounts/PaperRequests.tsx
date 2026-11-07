import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  PaperItem,
  PaperQueueSummary,
  PaperRequest,
  ThreadId,
} from "@t3tools/contracts";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { accountsState } from "./accountsState";
import { UniversityPicker } from "./University";
import { useSignIn } from "./useSignIn";
import { useAccountBrowser } from "./useAccountBrowser";
import { useAccountCommand, useAccounts } from "./useAccounts";

const waitingWord = (count: number) => (count === 1 ? "1 paper waits" : `${count} papers wait`);

function requestLine(request: PaperRequest) {
  switch (request.kind) {
    case "university":
      return `${waitingWord(request.count)} for your university.`;
    case "sign-in":
      return `${waitingWord(request.count)} for you to sign in to ${request.site}.`;
    case "check":
      return `${waitingWord(request.count)} for you to pass ${request.site}'s check.`;
  }
}

const ACTION_LABELS: Readonly<Record<PaperRequest["kind"], string>> = {
  university: "Connect your university",
  "sign-in": "Sign in",
  check: "Open",
};

/** One line per thing only the user can do; acting on it releases every paper waiting on it. */
function Requests({
  environmentId,
  queue,
  canWrite,
  threadId,
}: {
  environmentId: EnvironmentId;
  queue: PaperQueueSummary;
  canWrite: boolean;
  /** The conversation it shows in; a sign-in opens beside it. */
  threadId?: ThreadId;
}) {
  const resume = useAccountCommand(accountsState.continuePapers, environmentId);
  const openBrowser = useAccountBrowser(environmentId);
  const signIn = useSignIn(environmentId);
  const [connecting, setConnecting] = useState(false);
  const act = (request: PaperRequest) => {
    if (request.kind === "university") return setConnecting((current) => !current);
    // Papers go on by themselves when the sign-in finishes.
    if (request.kind === "sign-in" && request.accountId)
      return void signIn(request.accountId, threadId ? { threadId } : {});
    if (request.openUrl)
      void openBrowser(
        request.openUrl,
        request.profileId,
        threadId ? scopeThreadRef(environmentId, threadId) : undefined,
      );
    void resume({ root: queue.root });
  };
  return (
    <>
      {queue.requests.map((request) => (
        <div key={`${request.kind}:${request.site ?? ""}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">
            {requestLine(request)}
          </span>
          <Button size="xs" variant="outline" disabled={!canWrite} onClick={() => act(request)}>
            {ACTION_LABELS[request.kind]}
          </Button>
        </div>
      ))}
      {connecting ? (
        <UniversityPicker
          environmentId={environmentId}
          {...(threadId ? { threadId } : {})}
          autoFocus
          onChosen={() => setConnecting(false)}
        />
      ) : null}
    </>
  );
}

/** The papers that could not be reached, each with why; nothing is skipped silently. */
function UnreachedPapers({
  environmentId,
  root,
  count,
  onDismiss,
}: {
  environmentId: EnvironmentId;
  root: string;
  count: number;
  onDismiss: () => void;
}) {
  const list = useAccountCommand(accountsState.listPapers, environmentId);
  const [items, setItems] = useState<ReadonlyArray<PaperItem> | null>(null);
  const show = async () => {
    const result = await list({ root });
    if (result.ok)
      setItems(
        result.value.filter((item) => item.state === "no-access" || item.state === "not-found"),
      );
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-sm text-muted-foreground">
          {count === 1 ? "1 paper couldn't be reached." : `${count} papers couldn't be reached.`}
        </span>
        {items === null ? (
          <Button size="xs" variant="ghost" onClick={() => void show()}>
            Show
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon />
        </Button>
      </div>
      {items?.map((item) => (
        <div key={item.itemId} className="text-xs text-muted-foreground">
          <span className="text-foreground">{item.title ?? item.doi ?? item.url}</span>
          {item.message ? ` · ${item.message}` : ""}
        </div>
      ))}
    </>
  );
}

/** Progress of a project's papers above its Sources. Quiet when nothing is going on. */
export function PaperQueueBand({
  environmentId,
  root,
  threadId,
}: {
  environmentId: EnvironmentId;
  root: string;
  threadId: ThreadId;
}) {
  const { data, canWrite } = useAccounts(environmentId);
  const [dismissedFailed, setDismissedFailed] = useState(0);
  const queue = data?.paperQueues?.find((item) => item.root === root);
  const failed = queue && queue.failed !== dismissedFailed ? queue.failed : 0;
  if (!queue || (queue.waiting === 0 && queue.requests.length === 0 && failed === 0)) return null;
  return (
    <div className="grid gap-1.5 border-b px-3 py-2">
      {queue.waiting > 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          Getting {queue.waiting} {queue.waiting === 1 ? "paper" : "papers"}, {queue.saved} saved
          {queue.paused.length > 0
            ? `. ${queue.paused.map((item) => item.site).join(", ")} asked Scient to slow down`
            : ""}
        </div>
      ) : null}
      <Requests
        environmentId={environmentId}
        queue={queue}
        canWrite={canWrite}
        threadId={threadId}
      />
      {failed > 0 ? (
        <UnreachedPapers
          environmentId={environmentId}
          root={root}
          count={failed}
          onDismiss={() => setDismissedFailed(failed)}
        />
      ) : null}
    </div>
  );
}

/** What a conversation's papers need from the user, above its composer. */
export function ThreadPaperRequests({
  environmentId,
  queue,
  canWrite,
  threadId,
}: {
  environmentId: EnvironmentId;
  queue: PaperQueueSummary;
  canWrite: boolean;
  threadId: ThreadId;
}) {
  return (
    <div className="mb-2 grid gap-1.5 rounded-lg border bg-card p-3">
      <Requests
        environmentId={environmentId}
        queue={queue}
        canWrite={canWrite}
        threadId={threadId}
      />
    </div>
  );
}
