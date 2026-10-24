// SCIENT-OWNED: the Overleaf tab in the side panel. It opens only for a
// conflict or by "See changes": what came in, what was sent, and for each
// conflict the four ways to settle it.
import type {
  EnvironmentId,
  ScientOverleafChange,
  ScientOverleafConflictChoice,
  ScientOverleafReview,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, FileDiff, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useRightPanelStore } from "~/rightPanelStore";
import { OverleafMark } from "~/scient/files/ExternalFolderMarks";

import {
  conflictWorkspacePaths,
  openOverleafProject,
  readOverleafChanges,
  runOverleafSync,
} from "./overleafActions";
import { askAgentMessage, choicesFor, overleafResultView, workspacePathOf } from "./overleafModel";
import { useOverleafWorkspace } from "./overleafStore";

/** A person's choice: the engine's three, plus "Ask the agent", which writes the marks too. */
export type OverleafReviewChoice = ScientOverleafConflictChoice | "agent";

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
  const preview = workspace.previews.get(connectionId) ?? null;
  const syncing = workspace.syncing.has(connectionId);
  const composer = useComposerHandleContext();
  const [chosen, setChosen] = useState<ReadonlyMap<string, OverleafReviewChoice>>(new Map());
  const lastReview =
    last && (last.result._tag === "synced" || last.result._tag === "needs-decision")
      ? last.result.review
      : null;
  const review: ScientOverleafReview | null = lastReview ?? preview;
  const resultView = last ? overleafResultView(last.result) : null;
  const reading = workspace.previewing.has(connectionId);
  const readError = workspace.previewErrors.get(connectionId) ?? null;
  const readChanges = () => void readOverleafChanges(environmentId, cwd, connectionId);

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
  const conflicts = review?.conflicts ?? [];
  const engineChoices = new Map<string, ScientOverleafConflictChoice>(
    [...chosen].map(([key, choice]) => [key, choice === "agent" ? "markers" : choice]),
  );
  const allChosen =
    conflicts.length > 0 &&
    conflicts.every((conflict) => chosen.has(conflict.key) || conflict.chosen !== null);

  const syncWithChoices = async () => {
    if (!review) return;
    const askAgent = conflicts.filter((conflict) => chosen.get(conflict.key) === "agent");
    const result = await runOverleafSync(
      { environmentId, workspaceRoot: cwd, connection, openReview },
      choicesFor(review, engineChoices),
    );
    if (result?._tag !== "synced") return;
    setChosen(new Map());
    if (askAgent.length === 0) return;
    const paths = conflictWorkspacePaths(
      connection,
      askAgent.flatMap((conflict) => conflict.paths),
    );
    const inserted = composer?.current?.insertTextAtEnd(askAgentMessage(paths), {
      ensureLeadingBoundary: true,
    });
    if (inserted) composer?.current?.focusAtEnd();
    else
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
          {threadRef && review && (review.incoming.length > 0 || review.outgoing.length > 0) ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Show in Diff"
                    onClick={() => useRightPanelStore.getState().open(threadRef, "diff")}
                  />
                }
              >
                <FileDiff aria-hidden className="scient-quiet-icon size-4" />
              </TooltipTrigger>
              <TooltipPopup>Show in Diff</TooltipPopup>
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
            onClick={() =>
              void runOverleafSync({ environmentId, workspaceRoot: cwd, connection, openReview })
            }
          >
            <RefreshCw aria-hidden className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
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
          ) : null}
          {conflicts.length > 0 ? (
            <section className="flex flex-col gap-2" aria-label="Conflicts">
              <h3 className="px-1 text-xs font-medium text-muted-foreground">
                {conflicts.length === 1 ? "1 conflict" : `${conflicts.length} conflicts`}
              </h3>
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
                          onClick={() => props.onOpenFile(workspacePathOf(connection.folder, path))}
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
              <ChangeList
                title={lastReview ? "Came in" : "To bring in"}
                icon={ArrowDownToLine}
                changes={review.incoming}
                folder={connection.folder}
                onOpenFile={props.onOpenFile}
              />
              <ChangeList
                title={
                  lastReview &&
                  last?.result._tag === "synced" &&
                  last.result.publication._tag === "accepted"
                    ? "Sent"
                    : "To send"
                }
                icon={ArrowUpFromLine}
                changes={review.outgoing}
                folder={connection.folder}
                onOpenFile={props.onOpenFile}
              />
            </>
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
