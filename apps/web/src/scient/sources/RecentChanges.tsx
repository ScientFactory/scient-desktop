import type { EnvironmentId, ScientSourcesRecentChange } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import type { BulkUndoPart } from "./bulkParts";
import {
  organizeScientSources,
  readScientSourceRecentChanges,
  restoreScientSource,
} from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import { undoProblem, unrevertedLabel } from "./libraryDuplicateLabels";
import {
  RECENT_CHANGES_LABELS,
  recentChangeBy,
  recentChangeDetail,
  recentChangeSentence,
  recentChangeState,
} from "./recentChangeLabels";
import { settleAfter } from "./settleAfter";
import { restoreProblem } from "./sourceLifecycleLabels";

const PAGE = 50;
const MOST = 400;
const errorMessage = (cause: unknown) => scientSourcesErrorMessage(cause, import.meta.env.DEV);

/**
 * The Library's recorded changes, newest first, each with the one thing that can be done about
 * it now. Every action is the command the panel already has, checked again when it runs.
 */
export function RecentChangesDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** False for a session that may only read: the rows show, without Undo or Restore. */
  readonly canChange: boolean;
  /** Undoes a bulk edit request by request, with the panel's progress and messages. */
  readonly onUndoBulkEdit: (parts: ReadonlyArray<BulkUndoPart>) => Promise<unknown>;
  readonly onShowSources: (sourceIds: ReadonlyArray<string>) => void;
  /** The Library changed: the list behind the dialog reads it again. */
  readonly onChanged: () => Promise<unknown>;
  /** Starts adding what a Library folder holds; the panel shows its progress. */
  readonly onAddFromLibrary: (fromFolder: string) => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const { environmentId, root } = props;
  const [limit, setLimit] = useState(PAGE);
  const [listed, setListed] = useState<{
    readonly changes: ReadonlyArray<ScientSourcesRecentChange>;
    readonly more: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const latest = useRef(0);
  // The newest request's answer is the one shown, whether asked on opening or after an action.
  const load = useStableCallback(
    async (request: { readonly root: string; readonly limit: number }) => {
      latest.current += 1;
      const asked = latest.current;
      try {
        const result = await readScientSourceRecentChanges(environmentId, request);
        if (asked !== latest.current) return;
        setListed(result);
        setError(null);
      } catch (cause) {
        if (asked === latest.current) setError(errorMessage(cause));
      }
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the recorded changes from the environment when the dialog opens and when more are asked for
  useEffect(() => {
    void load({ root, limit });
  }, [root, limit, load]);

  const act = (work: () => Promise<string | null>) => {
    setWorking(true);
    setNotice(null);
    void settleAfter(
      async () => {
        try {
          setNotice(await work());
        } catch (cause) {
          setNotice(errorMessage(cause));
        }
        await props.onChanged().catch(() => undefined);
        await load({ root, limit });
      },
      () => setWorking(false),
    );
  };

  const action = (change: ScientSourcesRecentChange) => {
    switch (change.kind) {
      case "bulk-edit":
        return {
          label: RECENT_CHANGES_LABELS.undo,
          // Only what is not undone yet, in the edit's order: the panel undoes the newest part
          // first and says what was undone and what was left; the row then shows it too.
          run: () =>
            act(() =>
              props
                .onUndoBulkEdit(
                  change.parts.flatMap(({ undone, ...part }) => (undone ? [] : [part])),
                )
                .then(() => null),
            ),
        };
      case "merge":
        return {
          label: RECENT_CHANGES_LABELS.undo,
          run: () =>
            act(async () => {
              const result = await organizeScientSources(environmentId, {
                root,
                change: { action: "undo-merge", mergeId: change.id },
              });
              return undoProblem(result) ?? unrevertedLabel(result.unrevertedFields);
            }),
        };
      case "import":
        return {
          label: RECENT_CHANGES_LABELS.showSources,
          always: true,
          run: () => {
            setWorking(true);
            void settleAfter(
              () =>
                readScientSourceRecentChanges(environmentId, { root, sourcesOfImport: change.id })
                  .then((result) => {
                    props.onShowSources(result.importSourceIds ?? []);
                    props.onClose();
                  })
                  .catch((cause: unknown) => setNotice(errorMessage(cause))),
              () => setWorking(false),
            );
          },
        };
      // Offered while the Library the restore replaced is kept: add what it holds to this one.
      case "restore":
        return {
          label: RECENT_CHANGES_LABELS.addKept,
          run: () => {
            if (!change.kept) return;
            void props.onAddFromLibrary(change.kept.path);
            props.onClose();
          },
        };
      case "join":
        return {
          label: RECENT_CHANGES_LABELS.undo,
          run: () =>
            act(async () => {
              const result = await organizeScientSources(environmentId, {
                root,
                change: { action: "undo-join", joinId: change.id },
              });
              const left = result.joinUndone?.left ?? 0;
              return left > 0
                ? `${left.toLocaleString()} ${left === 1 ? "source" : "sources"} changed since and ${left === 1 ? "was" : "were"} left in the Library.`
                : null;
            }),
        };
      case "trash":
        return {
          label: RECENT_CHANGES_LABELS.restore,
          run: () =>
            act(async () =>
              restoreProblem(
                await restoreScientSource(environmentId, { root, sourceId: change.id }),
              ),
            ),
        };
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{RECENT_CHANGES_LABELS.title}</DialogTitle>
          <DialogDescription>{RECENT_CHANGES_LABELS.coverage}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {notice ? (
            <p role="status" className="mb-3 text-sm text-muted-foreground">
              {notice}
            </p>
          ) : null}
          {listed !== null && error ? (
            <p role="alert" className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              {RECENT_CHANGES_LABELS.reloadFailed}
              <Button
                size="xs"
                variant="ghost"
                disabled={working}
                onClick={() => void load({ root, limit })}
              >
                {RECENT_CHANGES_LABELS.tryAgain}
              </Button>
            </p>
          ) : null}
          {listed === null ? (
            <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
              {error ? RECENT_CHANGES_LABELS.loadFailed : RECENT_CHANGES_LABELS.loading}
            </p>
          ) : listed.changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{RECENT_CHANGES_LABELS.none}</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {listed.changes.map((change) => {
                const state = recentChangeState(change);
                const offered = action(change);
                const sentence = recentChangeSentence(change);
                return (
                  <li
                    key={`${change.kind}:${change.id}`}
                    className="flex items-start justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="break-words">{sentence}</p>
                      <p className="text-xs text-muted-foreground">
                        {recentChangeBy(change)} · {new Date(change.at).toLocaleString()}
                      </p>
                      {recentChangeDetail(change) ? (
                        <p className="text-xs break-words text-muted-foreground">
                          {recentChangeDetail(change)}
                        </p>
                      ) : null}
                    </div>
                    {state ? (
                      <span className="max-w-56 shrink-0 text-right text-xs break-words text-muted-foreground">
                        {state}
                      </span>
                    ) : offered.always || props.canChange ? (
                      <Button
                        className="shrink-0"
                        size="xs"
                        variant="outline"
                        disabled={working || (change.kind === "import" && change.available === 0)}
                        aria-label={`${offered.label}: ${sentence}`}
                        onClick={offered.run}
                      >
                        {offered.label}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {listed?.more && limit < MOST ? (
            <Button
              className="mt-3"
              size="xs"
              variant="ghost"
              disabled={working}
              onClick={() => setLimit((value) => Math.min(MOST, value * 2))}
            >
              {RECENT_CHANGES_LABELS.showOlder}
            </Button>
          ) : listed?.more ? (
            <p className="mt-3 text-xs text-muted-foreground">{RECENT_CHANGES_LABELS.noOlder}</p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
