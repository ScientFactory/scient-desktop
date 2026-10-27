// SCIENT-OWNED: the Overleaf tab in the side panel. It opens only for a
// conflict or by "See changes": what came in, what was sent, and for each
// conflict the four ways to settle it.
import type {
  EnvironmentId,
  ScientOverleafChange,
  ScientOverleafConflictChoice,
  ScientOverleafReview,
  ScientOverleafDiffResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ExternalLink,
  FileDiff,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { readOverleafDiff } from "./client";

import { OverleafMark } from "~/scient/files/ExternalFolderMarks";

import {
  cancelOverleafRun,
  conflictWorkspacePaths,
  openOverleafProject,
  readOverleafChanges,
  runOverleafSync,
} from "./overleafActions";
import { askAgentOnLinkedCopy, openFileOnLinkedCopy } from "./askAgentOnLinkedCopy";
import { appendToThreadDraft, sameThread, useReadShownThread } from "./overleafThreadTarget";
import { OverleafNewFiles } from "./OverleafNewFiles";
import { OverleafUndoDialog } from "./OverleafUndoDialog";
import {
  askAgentMessage,
  choicesFor,
  decidableFiles,
  outgoingAfterDecisions,
  overleafResultView,
  readNothingToDoLine,
  reviewIdentity,
  workspacePathOf,
  type OverleafFileDecision,
} from "./overleafModel";
import {
  pendingOverleafDecisions,
  setOverleafFileDecision,
  setOverleafConflictChoices,
  type OverleafReviewChoice,
  useOverleafWorkspace,
} from "./overleafStore";
import { useOverleafAgentRunWatch } from "./useOverleafAgentRunWatch";

/** A person's choice: the engine's three, plus "Ask the agent", which writes the marks too. */
export type { OverleafReviewChoice } from "./overleafStore";

const CHOICE_LABELS: Record<OverleafReviewChoice, string> = {
  mine: "Keep mine",
  theirs: "Use Overleaf's",
  markers: "Merge myself",
  agent: "Ask the agent",
};

function choicesOffered(allowed: ReadonlyArray<ScientOverleafConflictChoice>) {
  const offered: OverleafReviewChoice[] = [];
  if (allowed.includes("mine")) offered.push("mine");
  if (allowed.includes("theirs")) offered.push("theirs");
  if (allowed.includes("markers")) offered.push("markers", "agent");
  return offered;
}

function changeLabel(change: ScientOverleafChange): string {
  return change.kind === "renamed" ? `${change.from} → ${change.to}` : change.path;
}

function changePath(change: ScientOverleafChange): string | null {
  if (change.kind === "deleted") return null;
  return change.kind === "renamed" ? change.to : change.path;
}

const KIND_LABELS: Record<ScientOverleafChange["kind"], string> = {
  added: "New",
  deleted: "Deleted",
  modified: "Changed",
  renamed: "Renamed",
};

function ChangeList(props: {
  readonly title: string;
  readonly icon: typeof ArrowDownToLine;
  readonly changes: ReadonlyArray<ScientOverleafChange>;
  readonly folder: string;
  readonly onOpenFile: (path: string) => void;
}) {
  if (props.changes.length === 0) return null;
  const Icon = props.icon;
  return (
    <section className="flex flex-col gap-1" aria-label={props.title}>
      <h3 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        {props.title}
      </h3>
      <ul className="flex flex-col">
        {props.changes.map((change) => {
          const path = changePath(change);
          return (
            <li key={changeLabel(change)}>
              <button
                type="button"
                disabled={path === null}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-accent/50 disabled:cursor-default disabled:hover:bg-transparent"
                onClick={() =>
                  path !== null && props.onOpenFile(workspacePathOf(props.folder, path))
                }
              >
                <span className="w-16 shrink-0 text-xs text-muted-foreground">
                  {KIND_LABELS[change.kind]}
                </span>
                <span className="min-w-0 truncate">{changeLabel(change)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** New files go to Overleaf by default; the review lists the ones it sends. */
function newFilesLine(count: number, sent: boolean): string {
  const files = count === 1 ? "1 new file" : `${count} new files`;
  return sent ? `${files} ${count === 1 ? "was" : "were"} sent.` : `${files} will be sent.`;
}

const OverleafReviewDiff = lazy(() =>
  import("./OverleafReviewDiff").then((module) => ({ default: module.OverleafReviewDiff })),
);

const NO_CHOICES: ReadonlyMap<string, OverleafReviewChoice> = new Map();

export function OverleafReviewPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly connectionId: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const { environmentId, cwd, connectionId, threadRef } = props;
  const workspace = useOverleafWorkspace(environmentId, cwd);
  const connection = workspace.connections.find((entry) => entry.connectionId === connectionId);
  const last = workspace.lastSync.get(connectionId);
  // The shown review is its own state: an operation that brings none (cancelled,
  // refused) leaves it, its conflicts and their choices in place.
  const shownState = workspace.reviews.get(connectionId) ?? null;
  const syncing = workspace.syncing.has(connectionId);
  const composer = useComposerHandleContext();
  const handleNewThread = useNewThreadHandler();
  const readShownThread = useReadShownThread();
  const choiceState = workspace.conflictChoices.get(connectionId);
  // Overleaf moved after the choices were made: the review the conflicts are shown again in.
  const [chooseAgainFor, setChooseAgainFor] = useState<string | null>(null);
  // The send the Undo dialog is open for.
  const [undoing, setUndoing] = useState<number | null>(null);
  // Per-file decisions wait for the tab's next Sync, which carries them. They live in the
  // store, so opening a file (which replaces this tab) keeps them; an applied sync clears them.
  const decideFile = (path: string, decision: OverleafFileDecision | null) =>
    setOverleafFileDecision(environmentId, connectionId, path, decision);
  const review: ScientOverleafReview | null = workspace.previewing.has(connectionId)
    ? null
    : (shownState?.review ?? null);
  const diffScope = JSON.stringify([environmentId, cwd, connectionId, review?.reviewId]);
  const [diffState, setDiffState] = useState<{
    scope: string;
    result: ScientOverleafDiffResult | null;
    error: string | null;
  } | null>(null);
  const shownDiff = diffState?.scope === diffScope ? diffState : null;
  const showDiff = async () => {
    if (review === null) return;
    const pending = { scope: diffScope, result: null, error: null };
    setDiffState(pending);
    try {
      const result = await readOverleafDiff(environmentId, {
        workspaceRoot: cwd,
        connectionId,
        reviewId: review.reviewId,
      });
      setDiffState((current) => (current === pending ? { ...pending, result } : current));
    } catch {
      setDiffState((current) =>
        current === pending
          ? { ...pending, error: "Couldn’t read the diff. Check again or try Show in Diff again." }
          : current,
      );
    }
  };
  const resultView = last ? overleafResultView(last.result) : null;
  // The review shown is what a sync here applied, rather than one still to run.
  const synced = shownState?.applied ?? false;
  const sent = shownState?.sent ?? false;
  // The files decisions can be made on: after a sync its new files are decided, and files kept
  // only here still can be sent. Decisions are reconciled with it before they are shown or sent,
  // so one for a file a fresh read no longer lists, or no longer allows, is dropped.
  const shownReview = review === null ? "" : reviewIdentity(review);
  // The store owns the decisions: reconciled with the review shown, and carried by every sync.
  const pendingDecisions = pendingOverleafDecisions(workspace, connectionId);
  const decidable = decidableFiles(
    shownState,
    workspace.submittedDecisions.get(connectionId) ?? null,
  );
  const reading = workspace.previewing.has(connectionId);
  const readError = workspace.previewErrors.get(connectionId) ?? null;
  const readNote = workspace.previewNotes.get(connectionId) ?? null;
  const readChanges = () => void readOverleafChanges(environmentId, cwd, connectionId);
  useOverleafAgentRunWatch(environmentId, cwd);
  // Another sync (an agent, another window) changed the link: its old review was dropped.
  const outdated = workspace.outdated.has(connectionId);
  // oxlint-disable-next-line t3code/react-effect-budget -- While the tab is on screen, a review another sync made outdated is read again from the server.
  useEffect(() => {
    if (outdated && !reading && !syncing)
      void readOverleafChanges(environmentId, cwd, connectionId);
  }, [outdated, reading, syncing, environmentId, cwd, connectionId]);
  const chosen = choiceState?.review === shownReview ? choiceState.choices : NO_CHOICES;
  const chooseAgain = chooseAgainFor !== null && chooseAgainFor === shownReview;
  const setChosen = (
    change: (
      current: ReadonlyMap<string, OverleafReviewChoice>,
    ) => ReadonlyMap<string, OverleafReviewChoice>,
  ) => setOverleafConflictChoices(environmentId, connectionId, shownReview, change(chosen));

  if (!connection) {
    return (
      <div className="scient-reading-ui flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {workspace.loaded ? "This folder is no longer linked to Overleaf." : "Loading…"}
      </div>
    );
  }

  const openReview = () => {
    // Already showing: nothing to open.
  };
  // A link in another copy of the project: its files open in their normal editor in a thread on
  // that copy, never as this checkout's file of the same name.
  const openFile = (workspacePath: string) => {
    if (connection.linkedHere) {
      props.onOpenFile(workspacePath);
      return;
    }
    void openFileOnLinkedCopy({
      environmentId,
      threadRef,
      connection,
      handleNewThread,
      relativePath: workspacePath,
    }).then((opened) => {
      if (!opened)
        toastManager.add({
          type: "warning",
          title: "Couldn't open the linked copy's file",
          description: "Start a thread on the linked copy to open it.",
        });
    });
  };
  // A sync that applied decided its review's conflicts: their controls go with it.
  const conflicts = synced ? [] : (review?.conflicts ?? []);
  // The send of the sync shown, which Undo can put back (design section 4.3).
  const sentAttempt =
    sent && last?.result._tag === "synced" && last.result.publication._tag === "accepted"
      ? (last.result.publication.attemptNumber ?? null)
      : null;
  const engineChoices = new Map<string, ScientOverleafConflictChoice>(
    [...chosen].map(([key, choice]) => [key, choice === "agent" ? "markers" : choice]),
  );
  const allChosen =
    conflicts.length > 0 &&
    conflicts.every((conflict) => chosen.has(conflict.key) || conflict.chosen !== null);

  /** The header's Sync; like every sync it carries the link's pending per-file decisions. */
  const syncNow = () =>
    runOverleafSync({ environmentId, workspaceRoot: cwd, connection, openReview });

  const syncWithChoices = async () => {
    if (!review) return;
    const askAgent = conflicts.filter((conflict) => chosen.get(conflict.key) === "agent");
    const result = await runOverleafSync(
      { environmentId, workspaceRoot: cwd, connection, openReview },
      {
        choices: choicesFor(review, engineChoices),
        reviewedRemote: review.remoteTree,
      },
    );
    if (result?._tag === "needs-decision") {
      // The fresh review has no choices yet; the old ones belonged to the review they answered.
      setChooseAgainFor(reviewIdentity(result.review));
      return;
    }
    if (result?._tag !== "synced") return;
    setChooseAgainFor(null);
    if (askAgent.length === 0) return;
    const paths = conflictWorkspacePaths(
      connection,
      askAgent.flatMap((conflict) => conflict.paths),
    );
    // In another worktree, this thread's agent can't see the marks: ask on the linked copy.
    if (!connection.linkedHere || result.linkedElsewhere) {
      const started = await askAgentOnLinkedCopy({
        environmentId,
        threadRef,
        connection,
        message: askAgentMessage(paths),
        handleNewThread,
      });
      if (!started)
        toastManager.add({
          type: "warning",
          title: "Couldn't ask the agent",
          description:
            "The conflict marks are in the linked copy's files. Start a thread there to ask.",
        });
      return;
    }
    const message = askAgentMessage(paths);
    // The window may show another thread by now: write only to the one that asked.
    if (sameThread(readShownThread(), threadRef)) {
      const inserted = composer?.current?.insertTextAtEnd(message, { ensureLeadingBoundary: true });
      if (inserted) {
        composer?.current?.focusAtEnd();
        return;
      }
    }
    if (threadRef) {
      appendToThreadDraft(threadRef, message);
      toastManager.add({
        type: "info",
        title: "The message for the agent is in the thread's draft",
        description: "Go back to the thread that synced to send it.",
      });
      return;
    }
    toastManager.add({
      type: "warning",
      title: "Couldn't ask the agent",
      description: "The conflict marks are in the files. Open a chat for this project to ask.",
    });
  };

  return (
    <TooltipProvider delay={100} closeDelay={0} timeout={400}>
      <div
        className="scient-reading-ui flex min-h-0 flex-1 flex-col bg-background"
        data-overleaf-review={connectionId}
      >
        <div className="flex h-10 min-h-10 shrink-0 items-center gap-1.5 border-b border-border/60 px-3">
          <OverleafMark aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {connection.folder === "" ? "This project" : connection.folder}
          </span>
          {/* Line changes of a review still to run; one a sync applied is no longer current. */}
          {review && !synced && (review.incoming.length > 0 || review.outgoing.length > 0) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Show in Diff"
                    disabled={
                      shownDiff !== null && shownDiff.result === null && shownDiff.error === null
                    }
                    onClick={() => void showDiff()}
                  />
                }
              >
                <FileDiff aria-hidden className="scient-quiet-icon size-4" />
              </TooltipTrigger>
              <TooltipPopup>Show in Diff</TooltipPopup>
            </Tooltip>
          ) : null}
          {sentAttempt !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Undo send"
                    disabled={syncing}
                    onClick={() => setUndoing(sentAttempt)}
                  />
                }
              >
                <Undo2 aria-hidden className="scient-quiet-icon size-[17px]" strokeWidth={1.75} />
              </TooltipTrigger>
              <TooltipPopup>Undo send</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Open in Overleaf"
                  onClick={() => openOverleafProject(connection.projectId)}
                />
              }
            >
              <ExternalLink aria-hidden className="scient-quiet-icon size-4" />
            </TooltipTrigger>
            <TooltipPopup>Open in Overleaf</TooltipPopup>
          </Tooltip>
          <Button
            size="xs"
            variant="outline"
            disabled={syncing}
            onClick={() => void (allChosen ? syncWithChoices() : syncNow())}
          >
            <RefreshCw aria-hidden className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
          {syncing ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void cancelOverleafRun(environmentId, cwd, connectionId)}
            >
              Cancel
            </Button>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pt-2.5 pb-4">
          {resultView ? (
            <div className="flex flex-col gap-1 px-1" role="status">
              <p className="text-sm font-medium">{resultView.title}</p>
              {resultView.lines.map((line) => (
                <p key={line} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
          {readNote ? (
            <p className="px-1 text-xs text-muted-foreground" role="status">
              {readNote}
            </p>
          ) : null}
          {readError ? (
            <div className="flex items-center gap-2 px-1 text-sm" role="alert">
              <span className="min-w-0 flex-1">{readError}</span>
              <Button size="xs" variant="outline" onClick={readChanges}>
                Try again
              </Button>
            </div>
          ) : review === null ? (
            reading || syncing ? (
              <p className="px-1 text-sm text-muted-foreground" role="status">
                Reading changes…
              </p>
            ) : (
              <Button size="xs" variant="outline" className="self-start" onClick={readChanges}>
                Read changes
              </Button>
            )
          ) : (
            // A shown review can be from an earlier sync: reading again shows what the next
            // sync would do, so new files can be decided before it sends them.
            <Button
              size="xs"
              variant="ghost"
              className="self-start"
              disabled={reading || syncing}
              onClick={readChanges}
            >
              {reading ? "Checking…" : "Check again"}
            </Button>
          )}
          {shownDiff ? (
            shownDiff.result ? (
              <Suspense
                fallback={
                  <p role="status" className="px-1 text-sm text-muted-foreground">
                    Reading line changes…
                  </p>
                }
              >
                <OverleafReviewDiff
                  result={
                    shownDiff.result._tag === "diff"
                      ? {
                          ...shownDiff.result,
                          outgoing: outgoingAfterDecisions(
                            shownDiff.result.outgoing,
                            pendingDecisions,
                          ),
                        }
                      : shownDiff.result
                  }
                />
              </Suspense>
            ) : (
              <p role="status" className="px-1 text-sm text-muted-foreground">
                {shownDiff.error ?? "Reading line changes…"}
              </p>
            )
          ) : null}
          {conflicts.length > 0 ? (
            <section className="flex flex-col gap-2" aria-label="Conflicts">
              <h3 className="px-1 text-xs font-medium text-muted-foreground">
                {conflicts.length === 1 ? "1 conflict" : `${conflicts.length} conflicts`}
              </h3>
              {chooseAgain ? (
                <p className="px-1 text-xs text-warning-foreground" role="status">
                  Overleaf changed since you chose. Choose again.
                </p>
              ) : null}
              {conflicts.map((conflict) => {
                const current = chosen.get(conflict.key) ?? conflict.chosen;
                return (
                  <div
                    key={conflict.key}
                    className="flex flex-col gap-2 rounded-lg border border-border/70 bg-card p-2.5"
                    data-conflict={conflict.key}
                  >
                    <div className="flex flex-col">
                      {conflict.paths.map((path) => (
                        <button
                          key={path}
                          type="button"
                          className="truncate text-left text-sm hover:underline"
                          onClick={() => openFile(workspacePathOf(connection.folder, path))}
                        >
                          {path}
                        </button>
                      ))}
                    </div>
                    <ToggleGroup
                      aria-label={`Settle ${conflict.paths[0] ?? "conflict"}`}
                      className="flex-wrap"
                      value={current ? [current] : []}
                      onValueChange={(value) => {
                        const next = value[0] as OverleafReviewChoice | undefined;
                        setChosen((map) => {
                          const copy = new Map(map);
                          if (next) copy.set(conflict.key, next);
                          else copy.delete(conflict.key);
                          return copy;
                        });
                      }}
                    >
                      {choicesOffered(conflict.allowed).map((choice) => (
                        <Toggle key={choice} value={choice}>
                          {CHOICE_LABELS[choice]}
                        </Toggle>
                      ))}
                    </ToggleGroup>
                  </div>
                );
              })}
              <Button
                size="sm"
                className="self-start"
                disabled={!allChosen || syncing}
                onClick={() => void syncWithChoices()}
              >
                Sync again
              </Button>
            </section>
          ) : null}
          {review ? (
            <>
              {!synced && readNothingToDoLine(review) ? (
                <p className="px-1 text-sm text-muted-foreground" role="status">
                  {readNothingToDoLine(review)}
                </p>
              ) : null}
              <ChangeList
                title={synced ? "Came in" : "To bring in"}
                icon={ArrowDownToLine}
                changes={review.incoming}
                folder={connection.folder}
                onOpenFile={openFile}
              />
              <ChangeList
                title={sent ? "Sent" : "To send"}
                icon={ArrowUpFromLine}
                changes={
                  synced
                    ? review.outgoing
                    : outgoingAfterDecisions(review.outgoing, pendingDecisions)
                }
                folder={connection.folder}
                onOpenFile={openFile}
              />
              {synced && review.selectedAdditions.length > 0 ? (
                <p className="px-1 text-xs text-muted-foreground" data-overleaf-new-files>
                  {newFilesLine(review.selectedAdditions.length, sent)}
                </p>
              ) : null}
              <OverleafNewFiles
                // After a sync, its new files are decided; files kept only here still can be sent.
                review={decidable ?? review}
                folder={connection.folder}
                decisions={pendingDecisions}
                // A decision made while a sync runs wouldn't be in it, yet would be cleared by it.
                disabled={syncing}
                onDecide={decideFile}
                onOpenFile={openFile}
              />
            </>
          ) : null}
        </div>
        {undoing !== null ? (
          <OverleafUndoDialog
            environmentId={environmentId}
            workspaceRoot={cwd}
            connection={connection}
            attemptNumber={undoing}
            onClose={() => setUndoing(null)}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
