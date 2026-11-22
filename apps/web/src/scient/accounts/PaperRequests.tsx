import { msg, T, useGT, useMessages } from "gt-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  PaperItem,
  PaperQueueSummary,
  PaperRequest,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { accountsState } from "./accountsState";
import { UniversityPicker } from "./University";
import { useSignIn } from "./useSignIn";
import { useAccountBrowser } from "./useAccountBrowser";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { m, type MessageResolver } from "~/i18n/messages";

function requestLine(request: PaperRequest, resolve: MessageResolver = m) {
  const count = request.count;
  const site = request.site;
  switch (request.kind) {
    case "university":
      return resolve(
        msg(
          "{count, plural, one {{count} paper waits} other {{count} papers wait}} for your university.",
          { count },
        ),
      );
    case "sign-in":
      return resolve(
        msg(
          "{count, plural, one {{count} paper waits} other {{count} papers wait}} for you to sign in to {site}.",
          { count, site },
        ),
      );
    case "check":
      return resolve(
        msg(
          "{count, plural, one {{count} paper waits} other {{count} papers wait}} for you to pass {site}''s check.",
          { count, site },
        ),
      );
    case "terms":
      return resolve(
        msg(
          "{count, plural, one {{count} paper waits} other {{count} papers wait}} for you to review and accept {site}''s terms.",
          { count, site },
        ),
      );
    case "access":
      return resolve(
        msg(
          "{count, plural, one {{count} paper waits} other {{count} papers wait}}: this conversation may not use {site}.",
          { count, site },
        ),
      );
  }
}

const ACTION_LABELS: Readonly<Record<PaperRequest["kind"], string>> = {
  university: msg("Connect your university"),
  "sign-in": msg("Sign in"),
  check: msg("Open", { $context: "verb, opens the site's check page" }),
  terms: msg("Open", { $context: "verb, opens the site's terms page" }),
  access: msg("Allow in Settings"),
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
  const navigate = useNavigate();
  const messages = useMessages();
  const [connecting, setConnecting] = useState(false);
  const act = (request: PaperRequest) => {
    if (request.kind === "university") return setConnecting((current) => !current);
    if (request.kind === "terms" && request.site && request.profileId)
      return void resume({
        root: queue.root,
        terms: { site: request.site, profileId: request.profileId },
      });
    // The papers keep trying for a while, so a change made there lets them through.
    if (request.kind === "access") void navigate({ to: "/settings/accounts" });
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
        <div
          key={`${request.kind}:${request.site ?? ""}:${request.profileId ?? ""}`}
          className="flex items-center gap-2"
        >
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">
            {requestLine(request, messages)}
          </span>
          <Button size="xs" variant="outline" disabled={!canWrite} onClick={() => act(request)}>
            {messages(ACTION_LABELS[request.kind])}
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
  const gt = useGT();
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
          {gt(
            "{count, plural, one {{count} paper couldn't be reached.} other {{count} papers couldn't be reached.}}",
            { count },
          )}
        </span>
        {items === null ? (
          <Button size="xs" variant="ghost" onClick={() => void show()}>
            <T>Show</T>
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" aria-label={gt("Dismiss")} onClick={onDismiss}>
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
  const gt = useGT();
  if (!queue || (queue.waiting === 0 && queue.requests.length === 0 && failed === 0)) return null;
  return (
    <div className="grid gap-1.5 border-b px-3 py-2">
      {queue.waiting > 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          {queue.paused.length > 0
            ? gt(
                "Getting {count, plural, one {{count} paper} other {{count} papers}}, {saved} saved. {sites} asked Scient to slow down",
                {
                  count: queue.waiting,
                  saved: queue.saved,
                  sites: queue.paused.map((item) => item.site).join(", "),
                },
              )
            : gt(
                "Getting {count, plural, one {{count} paper} other {{count} papers}}, {saved} saved",
                { count: queue.waiting, saved: queue.saved },
              )}
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
