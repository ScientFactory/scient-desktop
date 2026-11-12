import { LegendList } from "@legendapp/list/react";
import type {
  EnvironmentId,
  ScientSourcesDuplicateSource,
  ScientSourcesDuplicatesResult,
} from "@t3tools/contracts";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { ScrollArea } from "../../components/ui/scroll-area";
import { toastManager } from "../../components/ui/toast";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { readLibraryDuplicates } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import {
  DUPLICATE_LABELS,
  differingFields,
  differsLabel,
  fieldValue,
  keptDifferentLabel,
  mergedRowLabel,
  mergedTitleLabel,
  sectionCountLabel,
  shownOfTotalLabel,
  undoProblem,
  unrevertedLabel,
  type DuplicateField,
} from "./libraryDuplicateLabels";
import { PanelHeader } from "./PanelChrome";
import type { SourcesOrganize } from "./useSourcesOrganize";

export type DuplicatesSection = "pairs" | "merged";
type Pair = ScientSourcesDuplicatesResult["pairs"][number];
type Merge = ScientSourcesDuplicatesResult["merges"][number];

/** A pair is about this tall with one-line fields; real pairs measure themselves. */
const PAIR_ESTIMATED_SIZE = 200;

const pairKey = (pair: Pair) => pair.sources.map((side) => side.sourceId).join("\0");
const message = (cause: unknown) => scientSourcesErrorMessage(cause, import.meta.env.DEV);

/**
 * The Library's possible duplicates and the merges Undo can still reverse. Every change goes
 * through the panel's organize hook, so it is refused while a change in parts runs, resolves null
 * and leaves the pair and its dialog as they were.
 */
export function LibraryDuplicatesView(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly organize: Pick<SourcesOrganize, "organize" | "whenFree" | "pending" | "changes">;
  readonly canChange: boolean;
  readonly initialSection: DuplicatesSection;
  readonly onBack: () => void;
  /** A merge landed: the merged-away source has left the Library. */
  readonly onMerged: (mergedSourceId: string) => void;
}) {
  const context = `${props.environmentId}\0${props.root}`;
  const [section, setSection] = useState<DuplicatesSection>(props.initialSection);
  const [asks, setAsks] = useState(0);
  const [reading, setReading] = useState<{
    readonly context: string;
    readonly result: ScientSourcesDuplicatesResult | null;
    readonly error: string | null;
    /** The ask this answers. */
    readonly ask: number;
  } | null>(null);
  // Pairs settled here leave the list at once; the next read confirms it.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  const [merging, setMerging] = useState<{ readonly pair: Pair; readonly keep: string } | null>(
    null,
  );
  const current = reading?.context === context ? reading : null;
  // Try again. A change that lands (here, from a toast, or from a view that has closed since)
  // moves `changes`, which reads again too.
  const reload = () => setAsks((value) => value + 1);
  // Both only grow, so their sum moves whenever either does.
  const ask = asks + props.organize.changes;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the possible duplicates from the environment server when the screen opens and after each change that lands through the organize hook
  useEffect(() => {
    let live = true;
    void readLibraryDuplicates(props.environmentId, props.root).then(
      (result) => {
        if (!live) return;
        setReading({ context, result, error: null, ask });
        setSettled(new Set());
      },
      (cause: unknown) => {
        if (!live) return;
        setReading((previous) => ({
          context,
          result: previous?.context === context ? previous.result : null,
          error: message(cause),
          ask,
        }));
      },
    );
    return () => {
      live = false;
    };
  }, [props.environmentId, props.root, context, ask]);

  const { organize, whenFree } = props.organize;
  const settle = (pair: Pair) => setSettled((previous) => new Set([...previous, pairKey(pair)]));

  const undoMerge = async (mergeId: string) => {
    const result = await organize({ action: "undo-merge", mergeId }, DUPLICATE_LABELS.undoFailed);
    if (!result) return;
    const problem = undoProblem(result);
    toastManager.add(
      problem
        ? { type: "warning", title: DUPLICATE_LABELS.undoFailed, description: problem }
        : {
            type: "success",
            title: DUPLICATE_LABELS.mergeUndone,
            description: unrevertedLabel(result.unrevertedFields) ?? undefined,
          },
    );
  };

  const merge = async (pair: Pair, keep: string) => {
    const result = await organize(
      {
        action: "merge",
        sourceIds: pair.sources.map((side) => side.sourceId),
        survivorId: keep,
      },
      DUPLICATE_LABELS.mergeFailed,
    );
    if (!result) return;
    setMerging(null);
    settle(pair);
    const landed = result.outcome === "merged" ? result.merges?.[0] : undefined;
    if (!landed) {
      toastManager.add({
        type: "info",
        title: DUPLICATE_LABELS.mergeFailed,
        description:
          result.outcome === "already-merged"
            ? "They were already merged."
            : "One of them is no longer in the Library.",
      });
      return;
    }
    props.onMerged(landed.mergedSourceId);
    const kept = pair.sources.find((side) => side.sourceId === landed.survivorId);
    const id = toastManager.add({
      type: "success",
      title: mergedTitleLabel(kept?.title ?? null),
      description: keptDifferentLabel(landed.keptDifferent) ?? undefined,
      actionProps: {
        children: DUPLICATE_LABELS.undo,
        onClick: whenFree(() => {
          toastManager.close(id);
          void undoMerge(landed.mergeId);
        }),
      },
    });
  };

  const markNotDuplicates = async (pair: Pair) => {
    const sourceIds = [pair.sources[0].sourceId, pair.sources[1].sourceId] as const;
    const result = await organize(
      { action: "mark-distinct", sourceIds },
      DUPLICATE_LABELS.notDuplicatesFailed,
    );
    if (!result) return;
    settle(pair);
    const id = toastManager.add({
      type: "success",
      title: DUPLICATE_LABELS.markedNotDuplicates,
      description: DUPLICATE_LABELS.markedHelp,
      actionProps: {
        children: DUPLICATE_LABELS.undo,
        onClick: whenFree(() => {
          toastManager.close(id);
          void organize({ action: "clear-distinct", sourceIds }, DUPLICATE_LABELS.undoFailed).then(
            (cleared) => {
              if (!cleared) return;
              toastManager.add({ type: "success", title: DUPLICATE_LABELS.unmarked });
            },
          );
        }),
      },
    });
  };

  const result = current?.result ?? null;
  const pairs = (result?.pairs ?? []).filter((pair) => !settled.has(pairKey(pair)));
  const busy = props.organize.pending;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={DUPLICATE_LABELS.title} onBack={props.onBack} />
      <div className="shrink-0 px-3 pt-3">
        <ToggleGroup
          aria-label={DUPLICATE_LABELS.title}
          className="w-full *:flex-1"
          value={[section]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "pairs" || value === "merged") setSection(value);
          }}
        >
          <Toggle value="pairs">
            {sectionCountLabel(DUPLICATE_LABELS.pairsSection, result?.pairsTotal ?? 0)}
          </Toggle>
          <Toggle value="merged">
            {sectionCountLabel(DUPLICATE_LABELS.mergedSection, result?.mergesTotal ?? 0)}
          </Toggle>
        </ToggleGroup>
      </div>
      {current?.error ? (
        <div className="mx-3 mt-3 flex items-center gap-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">
            {DUPLICATE_LABELS.loadFailed}: {current.error}
          </span>
          <Button size="xs" variant="ghost" onClick={reload}>
            <RefreshCw />
            {DUPLICATE_LABELS.tryAgain}
          </Button>
        </div>
      ) : null}
      {result === null ? (
        current?.error ? null : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        )
      ) : section === "pairs" ? (
        pairs.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {DUPLICATE_LABELS.noPairs}
          </p>
        ) : (
          <LegendList<Pair>
            data={pairs}
            keyExtractor={pairKey}
            extraData={{ busy, canChange: props.canChange }}
            renderItem={({ item, index }) => (
              <div className={index > 0 ? "border-t border-border" : undefined}>
                <DuplicatePair
                  pair={item}
                  canChange={props.canChange}
                  busy={busy}
                  onMerge={() => setMerging({ pair: item, keep: item.keptByDefault })}
                  onNotDuplicates={() => void markNotDuplicates(item)}
                />
              </div>
            )}
            estimatedItemSize={PAIR_ESTIMATED_SIZE}
            drawDistance={PAIR_ESTIMATED_SIZE * 4}
            recycleItems={false}
            ListFooterComponent={
              shownOfTotalLabel(result.pairs.length, result.pairsTotal) ? (
                <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                  {shownOfTotalLabel(result.pairs.length, result.pairsTotal)}
                </p>
              ) : null
            }
            className="mt-2 min-h-0 flex-1 overscroll-contain"
          />
        )
      ) : result.merges.length === 0 ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {DUPLICATE_LABELS.noMerges}
        </p>
      ) : (
        <ScrollArea className="mt-2 min-h-0 flex-1">
          <ul className="divide-y divide-border">
            {result.merges.map((entry) => (
              <MergedRow
                key={entry.mergeId}
                merge={entry}
                canChange={props.canChange}
                busy={busy}
                onUndo={() => void undoMerge(entry.mergeId)}
              />
            ))}
          </ul>
          {shownOfTotalLabel(result.merges.length, result.mergesTotal) ? (
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {shownOfTotalLabel(result.merges.length, result.mergesTotal)}
            </p>
          ) : null}
        </ScrollArea>
      )}
      <MergeDialog
        merging={merging}
        busy={busy}
        onKeep={(keep) => setMerging((previous) => (previous ? { ...previous, keep } : previous))}
        onClose={() => setMerging(null)}
        onConfirm={(pair, keep) => void merge(pair, keep)}
      />
    </div>
  );
}

function DuplicatePair(props: {
  readonly pair: Pair;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly onMerge: () => void;
  readonly onNotDuplicates: () => void;
}) {
  const [left, right] = props.pair.sources;
  const differing = differingFields(left, right);
  return (
    <section className="@container/pair px-3 py-3" aria-label={fieldValue(left, "title")}>
      <p className="mb-2 text-xs text-muted-foreground">{differsLabel(differing)}</p>
      <div className="grid gap-2 @md/pair:grid-cols-2">
        <DuplicateSide source={left} differing={differing} />
        <DuplicateSide source={right} differing={differing} />
      </div>
      {props.canChange ? (
        <div className="mt-2 flex justify-end gap-1">
          <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onNotDuplicates}>
            {DUPLICATE_LABELS.notDuplicates}
          </Button>
          <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onMerge}>
            {DUPLICATE_LABELS.merge}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

const SIDE_FIELDS: ReadonlyArray<DuplicateField> = [
  "authors",
  "year",
  "journal",
  "identifiers",
  "pdf",
  "projects",
];

function DuplicateSide(props: {
  readonly source: ScientSourcesDuplicateSource;
  readonly differing: ReadonlyArray<DuplicateField>;
}) {
  const differs = (field: DuplicateField) => props.differing.includes(field);
  return (
    <div className="min-w-0 rounded-md border border-border px-2.5 py-2 text-xs">
      <p
        className="break-words text-sm font-medium"
        data-differs={differs("title") ? "true" : undefined}
      >
        {fieldValue(props.source, "title")}
      </p>
      {SIDE_FIELDS.map((field) => {
        const value = fieldValue(props.source, field);
        if (!value) return null;
        return (
          <p
            key={field}
            data-field={field}
            data-differs={differs(field) ? "true" : undefined}
            className={
              differs(field)
                ? "mt-0.5 break-words font-medium text-foreground"
                : "mt-0.5 break-words text-muted-foreground"
            }
          >
            {value}
          </p>
        );
      })}
    </div>
  );
}

function MergedRow(props: {
  readonly merge: Merge;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly onUndo: () => void;
}) {
  const { merge } = props;
  const kept = keptDifferentLabel(merge.keptDifferent);
  return (
    <li className="flex items-start gap-2 px-3 py-2.5 text-xs">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm">{mergedRowLabel(merge.mergedTitle, merge.kept)}</p>
        <p className="mt-0.5 text-muted-foreground">
          {new Date(merge.mergedAt).toLocaleDateString()} ·{" "}
          {merge.requested ? DUPLICATE_LABELS.requested : DUPLICATE_LABELS.automatic}
        </p>
        {kept ? <p className="mt-0.5 text-muted-foreground">{kept}</p> : null}
      </div>
      {props.canChange ? (
        <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onUndo}>
          {DUPLICATE_LABELS.undo}
        </Button>
      ) : null}
    </li>
  );
}

function MergeDialog(props: {
  readonly merging: { readonly pair: Pair; readonly keep: string } | null;
  readonly busy: boolean;
  readonly onKeep: (sourceId: string) => void;
  readonly onClose: () => void;
  readonly onConfirm: (pair: Pair, keep: string) => void;
}) {
  const { merging } = props;
  return (
    <AlertDialog
      open={merging !== null}
      onOpenChange={(open) => (!open ? props.onClose() : undefined)}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{DUPLICATE_LABELS.mergeTitle}</AlertDialogTitle>
          <AlertDialogDescription>{DUPLICATE_LABELS.mergeHelp}</AlertDialogDescription>
        </AlertDialogHeader>
        {merging ? (
          <div className="px-6">
            <RadioGroup
              aria-label={DUPLICATE_LABELS.keepThis}
              value={merging.keep}
              onValueChange={(value) => {
                if (typeof value === "string") props.onKeep(value);
              }}
            >
              {merging.pair.sources.map((side) => (
                <label
                  key={side.sourceId}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-xs"
                >
                  <Radio value={side.sourceId} />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-medium">
                      {fieldValue(side, "title")}
                    </span>
                    <span className="block text-muted-foreground">
                      {[
                        fieldValue(side, "year"),
                        fieldValue(side, "journal"),
                        fieldValue(side, "pdf"),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {side.sourceId === merging.pair.keptByDefault ? (
                      <span className="block text-muted-foreground">
                        {DUPLICATE_LABELS.suggested}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {DUPLICATE_LABELS.cancel}
          </AlertDialogClose>
          <Button
            disabled={props.busy || merging === null}
            onClick={() => (merging ? props.onConfirm(merging.pair, merging.keep) : undefined)}
          >
            {DUPLICATE_LABELS.merge}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
