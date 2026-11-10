import type {
  CloudConversation,
  ComputerRecord,
  ThreadIndexRow,
} from "@scientfactory/scient-cloud/api";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronLeftIcon, CloudIcon } from "lucide-react";
import { Fragment, useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { AppRouteModal, AppRouteModalClose } from "~/components/AppRouteModal";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { isElectron } from "~/env";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";

import { CloudApiError, type CloudApi } from "./cloudApi";

const isCloudApiError = Schema.is(CloudApiError);
import { SnapshotConversationView } from "./SnapshotConversationView";
import { useContinueHere } from "./useContinueHere";
import { hasCloudAccount, useCloudAccount } from "./useCloudAccount";

function ReaderFrame({
  title,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  back?: boolean | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppRouteModal label="Cloud conversations">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-2 border-b ps-3 pe-2 sm:ps-5">
          {back ? (
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="All cloud conversations"
              render={<Link to="/cloud" />}
            >
              <ChevronLeftIcon />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
          {actions}
          <AppRouteModalClose />
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">{children}</WorkspacePageContainer>
        </ScrollArea>
      </div>
    </AppRouteModal>
  );
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

/** Shows `children` once the person is signed in to the Scient account that holds the copies. */
function SignedIn({
  title,
  back,
  children,
}: {
  title: ReactNode;
  back?: boolean;
  children: (account: { api: CloudApi; userId: string }) => ReactNode;
}) {
  if (!hasCloudAccount()) {
    return (
      <ReaderFrame title={title} back={back}>
        <Notice>Cloud copies need Scient Connect, which this build doesn't include.</Notice>
      </ReaderFrame>
    );
  }
  return <SignedInAccount title={title} back={back} render={children} />;
}

function SignedInAccount({
  title,
  back,
  render,
}: {
  title: ReactNode;
  back: boolean | undefined;
  render: (account: { api: CloudApi; userId: string }) => ReactNode;
}) {
  const account = useCloudAccount();
  if (account.isSignedIn === undefined) {
    return (
      <ReaderFrame title={title} back={back}>
        {null}
      </ReaderFrame>
    );
  }
  if (!account.isSignedIn || account.userId === null) {
    return (
      <ReaderFrame title={title} back={back}>
        <Notice
          action={
            <Button size="sm" onClick={account.openSignIn}>
              Sign in
            </Button>
          }
        >
          Sign in to read the conversations your computers copied to Scient Cloud.
        </Notice>
      </ReaderFrame>
    );
  }
  // Keyed by account: switching accounts drops what the previous one loaded, in flight or shown.
  return (
    <Fragment key={account.userId}>{render({ api: account.api, userId: account.userId })}</Fragment>
  );
}

type Loaded<T> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly value: T };

function useLoaded<T>(load: () => Promise<T>, key: string): [Loaded<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; loaded: Loaded<T> }>({
    key,
    loaded: { status: "loading" },
  });
  const read = useEffectEvent(load);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from Scient Cloud over the network
  useEffect(() => {
    let cancelled = false;
    read().then(
      (value) => {
        if (!cancelled) setState({ key, loaded: { status: "ready", value } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            key,
            loaded: {
              status: "failed",
              message: isCloudApiError(error) ? error.message : "Scient Cloud couldn't be read.",
            },
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- "Try again" bumps `attempt` to read again.
  }, [key, attempt]);
  const loaded = state.key === key ? state.loaded : ({ status: "loading" } as const);
  return [
    loaded,
    () => {
      setState({ key, loaded: { status: "loading" } });
      setAttempt((value) => value + 1);
    },
  ];
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function computerLabel(computers: ReadonlyArray<ComputerRecord>, environmentId: string): string {
  return (
    computers.find((computer) => computer.environmentId === environmentId)?.label ??
    "Another computer"
  );
}

/** `/cloud`: every conversation the person's computers copied, by computer and project. */
export function CloudConversationsPage() {
  return (
    <SignedIn title="Cloud conversations">
      {({ api }) => <CloudConversationsList api={api} />}
    </SignedIn>
  );
}

function CloudConversationsList({ api }: { api: CloudApi }) {
  const [loaded, retry] = useLoaded(
    async () => ({ computers: await api.computers(), threads: await api.threads() }),
    "index",
  );
  const thisComputer = usePrimaryEnvironmentId();
  let body: ReactNode;
  if (loaded.status === "loading") {
    body = <Notice>Loading your conversations…</Notice>;
  } else if (loaded.status === "failed") {
    body = (
      <Notice
        action={
          <Button size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        }
      >
        {loaded.message}
      </Notice>
    );
  } else {
    const { computers, threads } = loaded.value;
    const visible = threads.filter((thread) => !thread.archived);
    body =
      visible.length === 0 ? (
        <Notice>
          Nothing copied yet. Turn on Cloud copy in Settings → Sharing & access on a computer, and
          its conversations show up here.
        </Notice>
      ) : (
        <div className="flex flex-col gap-8">
          {groupByComputer(visible).map(([environmentId, rows]) => (
            <section key={environmentId} className="flex flex-col gap-4">
              <h2 className="text-sm font-medium">
                {computerLabel(computers, environmentId)}
                {environmentId === thisComputer ? (
                  <span className="ms-2 font-normal text-muted-foreground">This computer</span>
                ) : null}
              </h2>
              {groupByProject(rows).map(([projectLabel, projectRows]) => (
                <div key={projectLabel} className="flex flex-col">
                  <h3 className="mb-1 text-xs text-muted-foreground">{projectLabel}</h3>
                  <ul className="flex flex-col">
                    {projectRows.map((row) => (
                      <li key={row.threadId}>
                        <ThreadLink row={row} computers={computers} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      );
  }
  return <ReaderFrame title="Cloud conversations">{body}</ReaderFrame>;
}

function ThreadLink({
  row,
  computers,
}: {
  row: ThreadIndexRow;
  computers: ReadonlyArray<ComputerRecord>;
}) {
  return (
    <Link
      to="/cloud/$environmentId/$threadId"
      params={{ environmentId: row.environmentId, threadId: row.threadId }}
      className="flex min-w-0 items-baseline gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="min-w-0 flex-1 truncate">{row.title}</span>
      {row.movedTo !== null ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          Continued on {computerLabel(computers, row.movedTo)}
        </span>
      ) : null}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatWhen(row.updatedAt)}
      </span>
    </Link>
  );
}

function groupByComputer(rows: ReadonlyArray<ThreadIndexRow>) {
  const groups = new Map<string, ThreadIndexRow[]>();
  for (const row of rows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    groups.set(row.environmentId, [...(groups.get(row.environmentId) ?? []), row]);
  }
  return [...groups.entries()];
}

function groupByProject(rows: ReadonlyArray<ThreadIndexRow>) {
  const groups = new Map<string, ThreadIndexRow[]>();
  for (const row of rows)
    groups.set(row.projectLabel, [...(groups.get(row.projectLabel) ?? []), row]);
  return [...groups.entries()];
}

/** `/cloud/$environmentId/$threadId`: one copied conversation, read-only. */
export function CloudConversationPage({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  return (
    <SignedIn title="Cloud conversation" back>
      {({ api }) => (
        <CloudConversationReader api={api} environmentId={environmentId} threadId={threadId} />
      )}
    </SignedIn>
  );
}

function CloudConversationReader({
  api,
  environmentId,
  threadId,
}: {
  api: CloudApi;
  environmentId: string;
  threadId: string;
}) {
  const [loaded, retry] = useLoaded(async () => {
    const [conversation, threads, computers] = await Promise.all([
      api.thread(environmentId, threadId),
      api.threads(),
      api.computers(),
    ]);
    const row = threads.find(
      (candidate) => candidate.environmentId === environmentId && candidate.threadId === threadId,
    );
    return { conversation, row: row ?? null, computers };
  }, `${environmentId}/${threadId}`);
  if (loaded.status !== "ready") {
    return (
      <ReaderFrame title="Cloud conversation" back>
        {loaded.status === "loading" ? (
          <Notice>Opening the conversation…</Notice>
        ) : (
          <Notice
            action={
              <Button size="sm" variant="outline" onClick={retry}>
                Try again
              </Button>
            }
          >
            {loaded.message}
          </Notice>
        )}
      </ReaderFrame>
    );
  }
  const { conversation, row, computers } = loaded.value;
  const source = computerLabel(computers, environmentId);
  return (
    <ReaderFrame
      title={conversation.snapshot.thread.title}
      back
      actions={row !== null && isElectron ? <ContinueHereButton api={api} row={row} /> : null}
    >
      <CopyFacts conversation={conversation} row={row} source={source} computers={computers} />
      <SnapshotConversationView conversation={conversation} loadBlob={api.blob} />
    </ReaderFrame>
  );
}

function CopyFacts({
  conversation,
  row,
  source,
  computers,
}: {
  conversation: CloudConversation;
  row: ThreadIndexRow | null;
  source: string;
  computers: ReadonlyArray<ComputerRecord>;
}) {
  const facts = [
    `From ${source}`,
    `copied ${formatWhen(conversation.snapshot.captured.capturedAt)}`,
    row?.branch ? `branch ${row.branch}` : null,
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className="mb-6 flex flex-col gap-1 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5">
        <CloudIcon aria-hidden className="size-3.5" />
        {facts.join(" · ")}
      </p>
      {conversation.snapshot.omittedRunningTurn !== null && row?.movedTo == null ? (
        <p>Still running on {source} when it went offline. This shows the last finished reply.</p>
      ) : null}
      {row?.movedTo != null ? <p>Continued on {computerLabel(computers, row.movedTo)}.</p> : null}
    </div>
  );
}

function ContinueHereButton({ api, row }: { api: CloudApi; row: ThreadIndexRow }) {
  const navigate = useNavigate();
  const continueHere = useContinueHere(api);
  const thisComputer = usePrimaryEnvironmentId();
  if (thisComputer === null || thisComputer === row.ownerEnvironmentId) return null;
  return (
    <>
      {continueHere.problem ? (
        <span className="text-xs text-destructive-foreground">{continueHere.problem}</span>
      ) : null}
      {continueHere.chooser}
      <Button
        size="sm"
        disabled={continueHere.running}
        onClick={async () => {
          const imported = await continueHere.run(row, thisComputer);
          if (imported === null) return;
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({
              environmentId: EnvironmentId.make(thisComputer),
              threadId: ThreadId.make(imported),
            }),
          });
        }}
      >
        {continueHere.running ? "Continuing…" : "Continue on this computer"}
      </Button>
    </>
  );
}
