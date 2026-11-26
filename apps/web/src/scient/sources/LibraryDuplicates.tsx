import { LegendList } from "@legendapp/list/react";
import type {
  EnvironmentId,
  ScientSourcesDuplicateSource,
  ScientSourcesDuplicatesResult,
} from "@t3tools/contracts";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useGT, useMessages } from "gt-react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { ScrollArea } from "../../components/ui/scroll-area";
import { toastManager } from "../../components/ui/toast";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { readLibraryDuplicates } from "./client";
import { sourcesErrorMessage } from "./errorMessage";
import {
  DUPLICATE_LABELS,
  damagedReceiptsLabel,
  differingFields,
  differsLabel,
  fieldValue,
  keptDifferentLabel,
  hasMergeValues,
  mergeDifferenceLabel,
  namedDifferencesLabel,
  mergedDateLabel,
  pairReasonLabel,
  mergedRowLabel,
  mergeStateLabel,
  sideSummary,
  mergedTitleLabel,
  sectionCountLabel,
  shownOfTotalLabel,
  undoProblem,
  unrevertedLabel,
  type DuplicateField,
} from "./libraryDuplicateLabels";
import { SOURCES_COLUMN, PanelHeader } from "./PanelChrome";
import { settleAfter } from "./settleAfter";
import type { SourcesOrganize } from "./useSourcesOrganize";

export type DuplicatesSection = "pairs" | "merged";
type Pair = ScientSourcesDuplicatesResult["pairs"][number];
type Merge = ScientSourcesDuplicatesResult["merges"][number];

/** A pair is about this tall with one-line fields; real pairs measure themselves. */
const PAIR_ESTIMATED_SIZE = 200;

// Sorted: a new read may list the sides the other way round, and the choice must follow the pair.
const pairKey = (pair: Pair) =>
  pair.sources
    .map((side) => side.sourceId)
    .toSorted()
    .join("\0");

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
  const gt = useGT();
  const m = useMessages();
  const [section, setSection] = useState<DuplicatesSection>(props.initialSection);
  // Merges Undo can reverse, or every merge with how it stands now.
  const [merges, setMerges] = useState<"undoable" | "all">("undoable");
  const context = `${props.environmentId}\0${props.root}\0${merges}`;
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
  // The source ID to keep, by pair, once the person chose a side.
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(new Map());
  const current = reading?.context === context ? reading : null;
  // Try again. A change that lands (here, from a toast, or from a view that has closed since)
  // moves `changes`, which reads again too.
  const reload = () => setAsks((value) => value + 1);
  // Both only grow, so their sum moves whenever either does.
  const ask = asks + props.organize.changes;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the possible duplicates from the environment server when the screen opens and after each change that lands through the organize hook
  useEffect(() => {
    let live = true;
    void readLibraryDuplicates(props.environmentId, props.root, { merges }).then(
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
          error: sourcesErrorMessage(cause),
          ask,
        }));
      },
    );
    return () => {
      live = false;
    };
  }, [props.environmentId, props.root, merges, context, ask]);

  const [loadingMore, setLoadingMore] = useState(false);
  // The next page of one list under the revision the shown one came with. A list that changed
  // meanwhile comes back from the top, and replaces what is shown rather than skip anything.
  const showMore = async (list: DuplicatesSection) => {
    const shown = current?.result;
    if (!shown || loadingMore) return;
    setLoadingMore(true);
    await settleAfter(
      async () => {
        try {
          const next = await readLibraryDuplicates(props.environmentId, props.root, {
            revision: shown.revision,
            pairOffset: shown.pairOffset + shown.pairs.length,
            mergeOffset: shown.mergeOffset + shown.merges.length,
            merges,
          });
          setReading((previous) => {
            if (previous?.context !== context || previous.result !== shown) return previous;
            if (next.restarted) return { ...previous, result: next };
            return {
              ...previous,
              result:
                list === "pairs"
                  ? { ...shown, pairs: [...shown.pairs, ...next.pairs] }
                  : { ...shown, merges: [...shown.merges, ...next.merges] },
            };
          });
          if (next.restarted)
            toastManager.add({ type: "info", title: m(DUPLICATE_LABELS.restarted) });
        } catch (cause) {
          toastManager.add({
            type: "warning",
            title: m(DUPLICATE_LABELS.loadFailed),
            description: sourcesErrorMessage(cause),
          });
        }
      },
      () => setLoadingMore(false),
    );
  };

  const { organize, whenFree } = props.organize;
  const settle = (pair: Pair) => setSettled((previous) => new Set([...previous, pairKey(pair)]));

  const undoMerge = async (mergeId: string) => {
    const result = await organize(
      { action: "undo-merge", mergeId },
      m(DUPLICATE_LABELS.undoFailed),
    );
    if (!result) return;
    const problem = undoProblem(result, m);
    toastManager.add(
      problem
        ? { type: "warning", title: m(DUPLICATE_LABELS.undoFailed), description: problem }
        : {
            type: "success",
            title: m(DUPLICATE_LABELS.mergeUndone),
            description: unrevertedLabel(result.unrevertedFields, m) ?? undefined,
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
      m(DUPLICATE_LABELS.mergeFailed),
    );
    if (!result) return;
    settle(pair);
    const landed = result.outcome === "merged" ? result.merges?.[0] : undefined;
    if (!landed) {
      toastManager.add({
        type: "info",
        title: m(DUPLICATE_LABELS.mergeFailed),
        description:
          result.outcome === "already-merged"
            ? gt("They were already merged.")
            : m(DUPLICATE_LABELS.oneGone),
      });
      return;
    }
    props.onMerged(landed.mergedSourceId);
    const kept = pair.sources.find((side) => side.sourceId === landed.survivorId);
    const id = toastManager.add({
      type: "success",
      title: mergedTitleLabel(kept?.title ?? null, m),
      description: keptDifferentLabel(landed.keptDifferent, m) ?? undefined,
      actionProps: {
        children: m(DUPLICATE_LABELS.undo),
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
      m(DUPLICATE_LABELS.notDuplicatesFailed),
    );
    if (!result) return;
    settle(pair);
    if (result.outcome === "not-found") {
      toastManager.add({
        type: "info",
        title: m(DUPLICATE_LABELS.notDuplicatesFailed),
        description: m(DUPLICATE_LABELS.oneGone),
      });
      return;
    }
    const id = toastManager.add({
      type: "success",
      title: m(DUPLICATE_LABELS.markedNotDuplicates),
      description: m(DUPLICATE_LABELS.markedHelp),
      actionProps: {
        children: m(DUPLICATE_LABELS.undo),
        onClick: whenFree(() => {
          toastManager.close(id);
          void organize(
            { action: "clear-distinct", sourceIds },
            m(DUPLICATE_LABELS.undoFailed),
          ).then((cleared) => {
            if (!cleared) return;
            toastManager.add({ type: "success", title: m(DUPLICATE_LABELS.unmarked) });
          });
        }),
      },
    });
  };

  const result = current?.result ?? null;
  const pairs = (result?.pairs ?? []).filter((pair) => !settled.has(pairKey(pair)));
  const busy = props.organize.pending;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={m(DUPLICATE_LABELS.title)} onBack={props.onBack} />
      <div className={`${SOURCES_COLUMN} shrink-0 px-3 pt-3`}>
        <ToggleGroup
          aria-label={m(DUPLICATE_LABELS.title)}
          className="w-full *:flex-1"
          value={[section]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "pairs" || value === "merged") setSection(value);
          }}
        >
          <Toggle value="pairs">
            {sectionCountLabel(m(DUPLICATE_LABELS.pairsSection), result?.pairsTotal ?? 0)}
          </Toggle>
          <Toggle value="merged">
            {sectionCountLabel(m(DUPLICATE_LABELS.mergedSection), result?.mergesTotal ?? 0)}
          </Toggle>
        </ToggleGroup>
      </div>
      {result?.damagedReceipts ? (
        <p className={`${SOURCES_COLUMN} mt-3 px-3 text-xs text-muted-foreground`}>
          {damagedReceiptsLabel(result.damagedReceipts.length, m)}
        </p>
      ) : null}
      {current?.error ? (
        <div
          className={`${SOURCES_COLUMN} mt-3 flex items-center gap-2 px-3 text-xs text-destructive`}
        >
          <span className="min-w-0 flex-1">
            {m(DUPLICATE_LABELS.loadFailed)}: {current.error}
          </span>
          <Button size="xs" variant="ghost" onClick={reload}>
            <RefreshCw />
            {m(DUPLICATE_LABELS.tryAgain)}
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
            {m(DUPLICATE_LABELS.noPairs)}
          </p>
        ) : (
          <LegendList<Pair>
            data={pairs}
            keyExtractor={pairKey}
            extraData={{ busy, canChange: props.canChange, chosen }}
            renderItem={({ item, index }) => {
              const keep = chosen.get(pairKey(item)) ?? item.keptByDefault;
              return (
                <div className={`${SOURCES_COLUMN} ${index > 0 ? "border-t border-border" : ""}`}>
                  <DuplicatePair
                    pair={item}
                    keep={keep}
                    canChange={props.canChange}
                    busy={busy}
                    onKeep={(sourceId) =>
                      setChosen((previous) => new Map(previous).set(pairKey(item), sourceId))
                    }
                    onMerge={() => void merge(item, keep)}
                    onNotDuplicates={() => void markNotDuplicates(item)}
                  />
                </div>
              );
            }}
            estimatedItemSize={PAIR_ESTIMATED_SIZE}
            drawDistance={PAIR_ESTIMATED_SIZE * 4}
            recycleItems={false}
            ListFooterComponent={
              <ShowMore
                shown={result.pairOffset + result.pairs.length}
                total={result.pairsTotal}
                loading={loadingMore}
                onShowMore={() => void showMore("pairs")}
              />
            }
            className="mt-2 min-h-0 flex-1 overscroll-contain"
          />
        )
      ) : (
        <>
          <div className={`${SOURCES_COLUMN} shrink-0 px-3 pt-2`}>
            <ToggleGroup
              aria-label={m(DUPLICATE_LABELS.mergedSection)}
              className="w-full *:flex-1"
              value={[merges]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "undoable" || value === "all") setMerges(value);
              }}
            >
              <Toggle value="undoable">{m(DUPLICATE_LABELS.canUndo)}</Toggle>
              <Toggle value="all">{m(DUPLICATE_LABELS.allMerges)}</Toggle>
            </ToggleGroup>
          </div>
          {result.merges.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {merges === "all" ? m(DUPLICATE_LABELS.noMergesAtAll) : m(DUPLICATE_LABELS.noMerges)}
            </p>
          ) : (
            <ScrollArea className="mt-2 min-h-0 flex-1">
              <ul className={`${SOURCES_COLUMN} divide-y divide-border`}>
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
              <ShowMore
                shown={result.mergeOffset + result.merges.length}
                total={result.mergesTotal}
                loading={loadingMore}
                onShowMore={() => void showMore("merged")}
              />
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}

function ShowMore(props: {
  readonly shown: number;
  readonly total: number;
  readonly loading: boolean;
  readonly onShowMore: () => void;
}) {
  const m = useMessages();
  const label = shownOfTotalLabel(props.shown, props.total, m);
  if (!label) return null;
  return (
    <div
      className={`${SOURCES_COLUMN} flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground`}
    >
      <span className="min-w-0 flex-1">{label}</span>
      <Button size="xs" variant="ghost" disabled={props.loading} onClick={props.onShowMore}>
        {m(DUPLICATE_LABELS.showMore)}
      </Button>
    </div>
  );
}

function DuplicatePair(props: {
  readonly pair: Pair;
  readonly keep: string;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly onKeep: (sourceId: string) => void;
  readonly onMerge: () => void;
  readonly onNotDuplicates: () => void;
}) {
  const m = useMessages();
  const { pair } = props;
  const [left, right] = pair.sources;
  const differing = differingFields(left, right);
  return (
    <section className="@container/pair px-3 py-3" aria-label={fieldValue(left, "title", m)}>
      <p className="mb-2 text-xs text-muted-foreground">
        {[pairReasonLabel(pair, m), differsLabel(differing, m)].filter(Boolean).join(" ")}
      </p>
      {props.canChange ? (
        // Each side is the choice of the one to keep; Merge merges at once and its toast undoes.
        <RadioGroup
          aria-label={m(DUPLICATE_LABELS.keepThis)}
          className="grid @md/pair:grid-cols-2"
          value={props.keep}
          onValueChange={(value) => {
            if (typeof value === "string") props.onKeep(value);
          }}
        >
          {pair.sources.map((side) => (
            <label
              key={side.sourceId}
              className="min-w-0 cursor-pointer rounded-md border border-border px-2.5 py-2 text-xs"
            >
              <span className="mb-1 flex items-center gap-2 text-muted-foreground">
                <Radio value={side.sourceId} disabled={props.busy} />
                {side.sourceId === pair.keptByDefault
                  ? `${m(DUPLICATE_LABELS.keepThis)} · ${m(DUPLICATE_LABELS.suggested)}`
                  : m(DUPLICATE_LABELS.keepThis)}
              </span>
              <DuplicateSide source={side} differing={differing} />
            </label>
          ))}
        </RadioGroup>
      ) : (
        <div className="grid gap-3 @md/pair:grid-cols-2">
          {pair.sources.map((side) => (
            <div
              key={side.sourceId}
              className="min-w-0 rounded-md border border-border px-2.5 py-2 text-xs"
            >
              <DuplicateSide source={side} differing={differing} />
            </div>
          ))}
        </div>
      )}
      {props.canChange ? (
        <div className="mt-2 flex justify-end gap-1">
          <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onNotDuplicates}>
            {m(DUPLICATE_LABELS.notDuplicates)}
          </Button>
          <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onMerge}>
            {m(DUPLICATE_LABELS.merge)}
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
  const m = useMessages();
  const differs = (field: DuplicateField) => props.differing.includes(field);
  return (
    <>
      <span
        className="block break-words text-sm font-medium"
        data-differs={differs("title") ? "true" : undefined}
      >
        {fieldValue(props.source, "title", m)}
      </span>
      {SIDE_FIELDS.map((field) => {
        const value = fieldValue(props.source, field, m);
        if (!value) return null;
        return (
          <span
            key={field}
            data-field={field}
            data-differs={differs(field) ? "true" : undefined}
            className={
              differs(field)
                ? "mt-0.5 block break-words font-medium text-foreground"
                : "mt-0.5 block break-words text-muted-foreground"
            }
          >
            {value}
          </span>
        );
      })}
    </>
  );
}

function MergedRow(props: {
  readonly merge: Merge;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly onUndo: () => void;
}) {
  const m = useMessages();
  const { merge } = props;
  const kept = keptDifferentLabel(merge.keptDifferent, m);
  const state = mergeStateLabel(merge.undo, m);
  // The first line names what differed only for two copies of one title still in the Library.
  const named =
    merge.kept && merge.kept.title === merge.mergedTitle
      ? null
      : namedDifferencesLabel(merge.differences, m);
  return (
    <li className="flex items-start gap-2 px-3 py-2.5 text-xs">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm">{mergedRowLabel(merge, m)}</p>
        {merge.kept ? (
          <p className="mt-0.5 break-words text-muted-foreground">
            {m(DUPLICATE_LABELS.keptSide)}: {sideSummary(merge.kept, { projects: true }, m)}
          </p>
        ) : null}
        {merge.merged ? (
          <p className="mt-0.5 break-words text-muted-foreground">
            {m(DUPLICATE_LABELS.mergedSide)}:{" "}
            {sideSummary({ ...merge.merged, otherProjects: [] }, { projects: false }, m)}
          </p>
        ) : null}
        {merge.differences
          // The first line already names both titles while the kept source is here.
          .filter(hasMergeValues)
          .filter((difference) => difference.field !== "title" || !merge.kept)
          .map((difference) => (
            <p key={difference.field} className="mt-0.5 break-words text-muted-foreground">
              {mergeDifferenceLabel(difference, m)}
            </p>
          ))}
        {named ? <p className="mt-0.5 break-words text-muted-foreground">{named}</p> : null}
        <p className="mt-0.5 text-muted-foreground">
          {[
            mergedDateLabel(merge.mergedAt),
            merge.requested ? m(DUPLICATE_LABELS.requested) : m(DUPLICATE_LABELS.automatic),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {kept ? <p className="mt-0.5 text-muted-foreground">{kept}</p> : null}
        {state ? <p className="mt-0.5 text-muted-foreground">{state}</p> : null}
      </div>
      {props.canChange && merge.undo === "available" ? (
        <Button size="xs" variant="ghost" disabled={props.busy} onClick={props.onUndo}>
          {m(DUPLICATE_LABELS.undo)}
        </Button>
      ) : null}
    </li>
  );
}
