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
import { scientSourcesErrorMessage } from "./errorMessage";
import { removedLabel, restoreProblem } from "./sourceLifecycleLabels";
import { useCanChangeLibrary } from "./sourcesCommands";

type TrashEntry = ScientSourceTrashListing["entries"][number];

const errorMessage = (cause: unknown) => scientSourcesErrorMessage(cause, import.meta.env.DEV);

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
  readonly onRestored: () => Promise<unknown>;
}) {
  const id = toastManager.add({
    type: "success",
    title: "Moved to Trash",
    description: input.title ?? undefined,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(id);
        void restoreSourceFromTrash(input)
          .then(input.onRestored)
          .catch((cause: unknown) =>
            toastManager.add({
              type: "error",
              title: "Source could not be restored",
              description: errorMessage(cause),
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
  const [listing, setListing] = useState<ScientSourceTrashListing | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingEmpty, setConfirmingEmpty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canChange = useCanChangeLibrary(props.environmentId);

  const load = async () => {
    try {
      setListing(await readScientSourceTrash(props.environmentId, { root: props.root }));
    } catch (cause) {
      setProblem(errorMessage(cause));
    }
  };

  const run = async (key: string, work: () => Promise<unknown>) => {
    setPending(key);
    setProblem(null);
    try {
      await work();
      await props.onChanged();
      await load();
    } catch (cause) {
      setProblem(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const entries = listing?.entries ?? [];
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
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <PopoverTitle>Trash</PopoverTitle>
          {entries.length > 0 ? (
            confirmingEmpty ? (
              <div className="flex items-center gap-1">
                <Button size="xs" variant="ghost" onClick={() => setConfirmingEmpty(false)}>
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={pending !== null || !canChange}
                  onClick={() =>
                    void run("empty", () =>
                      deleteScientSourcesPermanently(props.environmentId, { root: props.root }),
                    ).then(() => setConfirmingEmpty(false))
                  }
                >
                  {pending === "empty" ? <LoaderCircle className="animate-spin" /> : null}
                  Delete for good
                </Button>
              </div>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                disabled={!canChange}
                onClick={() => setConfirmingEmpty(true)}
              >
                Empty trash
              </Button>
            )
          ) : null}
        </div>
        {confirmingEmpty ? (
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            Sources in the trash, their saved versions and PDFs nothing else uses are deleted. This
            cannot be undone.
          </p>
        ) : null}
        {problem ? (
          <p className="px-3 pt-2 text-xs text-destructive" role="alert">
            {problem}
          </p>
        ) : null}
        <ScrollArea className="max-h-80">
          {listing === null ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">The trash is empty.</div>
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
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{props.entry.title ?? "Untitled source"}</div>
        <div className="truncate text-xs text-muted-foreground">{removedLabel(props.entry)}</div>
      </div>
      <Button size="xs" variant="ghost" disabled={props.disabled} onClick={props.onRestore}>
        {props.pending ? <LoaderCircle className="animate-spin" /> : null}
        Restore
      </Button>
    </li>
  );
}
