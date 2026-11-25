import { msg, T, useGT, useMessages } from "gt-react";

import { m } from "~/i18n/messages";
import type {
  EnvironmentId,
  ScientSourceRestoreResult,
  ScientSourceTrashListing,
} from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useState, type RefObject } from "react";

import { Button } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTitle } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { toastManager } from "../../components/ui/toast";
import {
  deleteScientSourcesPermanently,
  readScientSourceTrash,
  restoreScientSource,
} from "./client";
import { sourcesErrorMessage } from "./errorMessage";
import { alsoInOtherProjectsLabel } from "./libraryLabels";
import { byLine } from "./dayLabel";
import { restoreProblem } from "./sourceLifecycleLabels";
import { useCanChangeLibrary } from "./sourcesCommands";
import { settleAfter } from "./settleAfter";

type TrashEntry = ScientSourceTrashListing["entries"][number];

async function restoreSourceFromTrash(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
}): Promise<ScientSourceRestoreResult> {
  const result = await restoreScientSource(input.environmentId, {
    root: input.root,
    sourceId: input.sourceId,
  });
  const problem = restoreProblem(result);
  if (problem) throw new Error(problem);
  return result;
}

/** The toast right after a removal; Undo restores without opening the trash. */
export function announceSourceMovedToTrash(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceId: string;
  readonly title: string | null;
  /** On a personal Library: how many other projects have the source. */
  readonly alsoPinnedIn?: number;
  readonly onRestored: () => Promise<unknown>;
}) {
  const elsewhere = alsoInOtherProjectsLabel(input.alsoPinnedIn);
  const id = toastManager.add({
    type: "success",
    title: m(msg("Moved to Trash")),
    description: elsewhere
      ? [input.title, elsewhere].filter(Boolean).join(" ")
      : (input.title ?? undefined),
    actionProps: {
      children: m(msg("Undo", { $context: "verb, button that undoes a change" })),
      onClick: () => {
        toastManager.close(id);
        // The restore's own answer says whether it worked; a list read that fails after it is
        // the list's problem, shown where the list shows it.
        void restoreSourceFromTrash(input)
          .then(() => void input.onRestored().catch(() => undefined))
          .catch((cause: unknown) =>
            toastManager.add({
              type: "error",
              title: m(msg("Source could not be restored")),
              description: sourcesErrorMessage(cause),
            }),
          );
      },
    },
  });
}

export function SourceTrashPopover(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly open: boolean;
  readonly anchor: RefObject<HTMLElement | null>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChanged: () => Promise<unknown>;
}) {
  const gt = useGT();
  const [listing, setListing] = useState<ScientSourceTrashListing | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canChange = useCanChangeLibrary(props.environmentId);

  const load = async () => {
    try {
      setListing(await readScientSourceTrash(props.environmentId, { root: props.root }));
    } catch (cause) {
      setProblem(sourcesErrorMessage(cause));
    }
  };

  const run = async (key: string, work: () => Promise<unknown>) => {
    setPending(key);
    setProblem(null);
    await settleAfter(
      async () => {
        try {
          await work();
        } catch (cause) {
          setProblem(sourcesErrorMessage(cause));
          return;
        }
        // Each list is read on its own: the Library's failing leaves the Trash's to show.
        await Promise.all([props.onChanged().catch(() => undefined), load()]);
      },
      () => setPending(null),
    );
  };

  const entries = listing?.entries ?? [];
  const unfinished = listing?.unfinished ?? [];
  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      onOpenChangeComplete={(open) => {
        setConfirmingEmpty(false);
        setProblem(null);
        if (open) void load();
      }}
    >
      <PopoverPopup
        anchor={props.anchor}
        finalFocus={props.anchor}
        align="end"
        side="bottom"
        padding="none"
        className="w-[22rem] max-w-[calc(100vw-1rem)]"
      >
        <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border px-3 py-2">
          {confirmingEmpty ? (
            <PopoverTitle>
              {gt(
                "{count, plural, =1 {Delete 1 paper for good?} other {Delete {count} papers for good?}}",
                { count: entries.length },
              )}
            </PopoverTitle>
          ) : (
            <PopoverTitle>
              <T context="the Library's Trash">Trash</T>
            </PopoverTitle>
          )}
          {entries.length > 0 ? (
            confirmingEmpty ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button size="xs" variant="ghost" onClick={() => setConfirmingEmpty(false)}>
                  <T>Cancel</T>
                </Button>
                <Button
                  size="xs"
                  variant="ghost-destructive-action"
                  disabled={pending !== null || !canChange}
                  onClick={() =>
                    void run("empty", async () => {
                      const result = await deleteScientSourcesPermanently(props.environmentId, {
                        root: props.root,
                        ...(listing?.revision ? { trashRevision: listing.revision } : {}),
                      });
                      if (result.outcome === "changed") {
                        // The list is read again below; the person confirms what it now holds.
                        setProblem(gt("The Trash changed. Check it and try again."));
                        return;
                      }
                      setConfirmingEmpty(false);
                    })
                  }
                >
                  {pending === "empty" ? <LoaderCircle className="animate-spin" /> : null}
                  <T context="verb, deletes papers for good">Delete</T>
                </Button>
              </div>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={!canChange}
                onClick={() => setConfirmingEmpty(true)}
              >
                <T>Empty trash</T>
              </Button>
            )
          ) : null}
        </div>
        {problem ? (
          <p className="px-3 pt-2 text-xs text-destructive" role="alert">
            {problem}
          </p>
        ) : null}
        {unfinished.length > 0 ? (
          <div className="flex items-center justify-between gap-2 px-3 pt-2 text-xs text-muted-foreground">
            <T>Deleting for good did not finish.</T>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending !== null || !canChange}
              onClick={() =>
                void run("finish", () =>
                  deleteScientSourcesPermanently(props.environmentId, {
                    root: props.root,
                    removalIds: unfinished,
                  }),
                )
              }
            >
              {pending === "finish" ? <LoaderCircle className="animate-spin" /> : null}
              <T>Finish deleting</T>
            </Button>
          </div>
        ) : null}
        <ScrollArea className="max-h-80">
          {listing === null ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              <T>Loading…</T>
            </div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              <T>The trash is empty.</T>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {entries.map((entry) => (
                <TrashRow
                  key={entry.sourceId}
                  entry={entry}
                  pending={pending === entry.sourceId}
                  disabled={pending !== null || !canChange}
                  onRestore={() =>
                    void run(entry.sourceId, () =>
                      restoreSourceFromTrash({
                        environmentId: props.environmentId,
                        root: props.root,
                        sourceId: entry.sourceId,
                      }),
                    )
                  }
                />
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
}

function TrashRow(props: {
  readonly entry: TrashEntry;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onRestore: () => void;
}) {
  const resolve = useMessages();
  const gt = useGT();
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm wrap-break-word">
          {props.entry.title ?? gt("Untitled source")}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {byLine(props.entry.removedBy, props.entry.removedAt, resolve)}
        </div>
      </div>
      <Button size="xs" variant="ghost" disabled={props.disabled} onClick={props.onRestore}>
        {props.pending ? <LoaderCircle className="animate-spin" /> : null}
        <T context="verb, button">Restore</T>
      </Button>
    </li>
  );
}
