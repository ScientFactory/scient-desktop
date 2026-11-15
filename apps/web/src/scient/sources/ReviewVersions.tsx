import type {
  ScientSystematicReviewCombineReport,
  ScientSystematicReviewConflictsResult,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { toastManager } from "../../components/ui/toast";
import { scientSourcesErrorMessage } from "./errorMessage";
import {
  REVIEW_VERSION_LABELS,
  STAGE_WORDS,
  decisionText,
  differenceCounts,
  plural,
  reviewDate,
  rowHeading,
  searchText,
  type ReviewVersionDifferences,
} from "./reviewVersionLabels";
import { Sides } from "./Sides";
import type { SystematicReviews } from "./useSystematicReviews";

type Version = ScientSystematicReviewConflictsResult["versions"][number];
type Pick = "keep" | "use-other" | "combine";

function VersionSummary(props: { readonly heading: string; readonly version: Version | null }) {
  const { version } = props;
  return (
    <div className="min-w-0 space-y-1 rounded-md bg-muted/40 p-3 text-sm">
      <p className="text-xs text-muted-foreground">{props.heading}</p>
      {version ? (
        <>
          <p className="break-words font-medium">{version.title}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            Changed {reviewDate(version.updatedAt)}{" "}
            {version.updatedBy === "agent" ? "by an agent" : "by you"}
          </p>
          {version.deletedAt ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              Deleted {reviewDate(version.deletedAt)}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground tabular-nums">
            {plural(version.searches, "search", "searches")} ·{" "}
            {plural(version.records, "record", "records")} ·{" "}
            {plural(version.decisions, "decision", "decisions")}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {version.lastDecidedAt
              ? `Last decision ${reviewDate(version.lastDecidedAt)}`
              : "No decisions yet"}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This version could not be read.</p>
      )}
    </div>
  );
}

/** What the two versions do not share, both sides of each, a page at a time. */
function DifferenceRows(props: {
  readonly differences: ReviewVersionDifferences;
  readonly disabled: boolean;
  readonly onMore: () => void;
}) {
  const { rows, nextOffset } = props.differences;
  const names = {
    hereName: REVIEW_VERSION_LABELS.here,
    otherName: REVIEW_VERSION_LABELS.other,
  };
  return (
    <>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border text-sm">
          {rows.map((row) => {
            const heading = rowHeading(row);
            return (
              <li key={heading.key} className="py-3">
                <p className="font-medium break-words">{heading.title}</p>
                <p className="text-xs text-muted-foreground">{heading.standing}</p>
                {row.kind === "decision" ? (
                  <Sides
                    label="Decision"
                    here={decisionText(row.here)}
                    other={decisionText(row.other)}
                    {...names}
                  />
                ) : row.kind === "search" ? (
                  <Sides
                    label="Search"
                    here={searchText(row.here, row.other ? "only in this version" : null)}
                    other={searchText(row.other, row.here ? "only in the other version" : null)}
                    {...names}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {nextOffset !== null ? (
        <Button size="xs" variant="ghost" disabled={props.disabled} onClick={props.onMore}>
          {REVIEW_VERSION_LABELS.more}
        </Button>
      ) : null}
    </>
  );
}

/** Both versions of a review side by side, what differs between them, and the choice. */
function ReviewVersionsDialog(props: {
  readonly versions: ScientSystematicReviewConflictsResult | null;
  /** By other version: what differs from it, null when that could not be read. */
  readonly differences: ReadonlyMap<string, ReviewVersionDifferences | null>;
  readonly error: string | null;
  readonly disabled: boolean;
  /** A read is under way: no further rows are asked for. */
  readonly reading: boolean;
  readonly onChoose: (conflictId: string, pick: Pick) => void;
  readonly onMore: (conflictId: string, shown: ReviewVersionDifferences) => void;
  readonly onClose: () => void;
}) {
  const { disabled, onChoose: choose } = props;
  return (
    <Dialog open onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Versions of this review</DialogTitle>
          <DialogDescription>
            A copy of this project brought another version. The version not kept is stored aside,
            not deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.error ? (
            <p className="text-sm text-destructive-foreground">{props.error}</p>
          ) : props.versions === null ? null : (
            <div className="space-y-5">
              {props.versions.versions.map((version) => {
                const differences = props.differences.get(version.conflictId!);
                return (
                  <section key={version.conflictId} className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <VersionSummary
                        heading={REVIEW_VERSION_LABELS.here}
                        version={props.versions!.current}
                      />
                      <VersionSummary heading={REVIEW_VERSION_LABELS.other} version={version} />
                    </div>
                    {differences === undefined ? null : (
                      <p className="text-sm tabular-nums">
                        {differences
                          ? differenceCounts(differences)
                          : REVIEW_VERSION_LABELS.unreadable}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="compact"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => choose(version.conflictId!, "keep")}
                      >
                        Keep this version
                      </Button>
                      <Button
                        size="compact"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => choose(version.conflictId!, "use-other")}
                      >
                        Use the other
                      </Button>
                      <Button
                        size="compact"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => choose(version.conflictId!, "combine")}
                      >
                        Combine
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Combine keeps the searches and records of both versions, and reopens any
                      record the two decided differently.
                    </p>
                    {differences ? (
                      <DifferenceRows
                        differences={differences}
                        disabled={props.reading}
                        onMore={() => props.onMore(version.conflictId!, differences)}
                      />
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** "This review has another version": opens the picker, read fresh from the server. */
export function ReviewVersionsLine(props: {
  readonly reviews: SystematicReviews;
  readonly reviewId: string;
}) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<ScientSystematicReviewConflictsResult | null>(null);
  const [differences, setDifferences] = useState<
    ReadonlyMap<string, ReviewVersionDifferences | null>
  >(new Map());
  const [error, setError] = useState<string | null>(null);
  // A choice is offered only on versions, and their differences, read after the last opening
  // and the last choice.
  const [reading, setReading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const latestRead = useRef(0);
  const load = async () => {
    latestRead.current += 1;
    const read = latestRead.current;
    setReading(true);
    setDifferences(new Map());
    const next = await props.reviews.readConflicts(props.reviewId).catch((cause: unknown) => {
      if (read === latestRead.current) {
        setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
      }
      return null;
    });
    if (read !== latestRead.current) return;
    if (!next) {
      setReading(false);
      return;
    }
    setError(null);
    setVersions(next);
    if (next.versions.length === 0) setOpen(false);
    const pages = new Map<string, ReviewVersionDifferences | null>();
    for (const version of next.versions) {
      const page = await props.reviews
        .readConflicts(props.reviewId, { conflictId: version.conflictId!, offset: 0 })
        .catch(() => null);
      if (read !== latestRead.current) return;
      pages.set(version.conflictId!, page?.differences ?? null);
    }
    setDifferences(pages);
    setReading(false);
  };
  const showMore = async (conflictId: string, shown: ReviewVersionDifferences) => {
    const read = latestRead.current;
    setReading(true);
    const next = await props.reviews
      .readConflicts(props.reviewId, { conflictId, offset: shown.nextOffset ?? 0 })
      .catch(() => null);
    if (read !== latestRead.current) return;
    const page = next?.differences;
    // Another version in force, or this one settled elsewhere: the rows shown are of a pair
    // that no longer stands, so everything is read again.
    if (!page || next.currentRevision !== versions?.currentRevision) return load();
    setDifferences(
      new Map(differences).set(conflictId, { ...page, rows: [...shown.rows, ...page.rows] }),
    );
    setReading(false);
  };
  const choose = async (conflictId: string, pick: Pick) => {
    setChoosing(true);
    const currentRevision = versions?.currentRevision;
    const changed = await props.reviews.changeConflict(
      props.reviewId,
      {
        action: "resolve",
        conflictId,
        pick,
        ...(currentRevision ? { currentRevision } : {}),
      },
      "The version was not chosen",
    );
    if (changed && changed.outcome !== "resolved") {
      toastManager.add({
        type: "warning",
        title: "The version was not chosen",
        description:
          "This review changed somewhere else after these versions were read. Look at them again.",
      });
    }
    await load();
    setChoosing(false);
  };
  return (
    <>
      <button
        type="button"
        className="group block w-full cursor-pointer text-left text-sm text-muted-foreground outline-none"
        onClick={() => {
          setOpen(true);
          setVersions(null);
          setError(null);
          void load();
        }}
      >
        This review has another version from a copy of this project.{" "}
        <span className="text-foreground underline underline-offset-2 group-hover:decoration-2 group-focus-visible:decoration-2">
          Show versions
        </span>
      </button>
      {open ? (
        <ReviewVersionsDialog
          versions={versions}
          differences={differences}
          error={error}
          disabled={props.reviews.conflictsDisabled || reading || choosing}
          reading={reading || choosing}
          onChoose={(conflictId, pick) => void choose(conflictId, pick)}
          onMore={(conflictId, shown) => void showMore(conflictId, shown)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** What Combine left for a person, kept on the review until dismissed. */
export function CombineReportNotice(props: {
  readonly reviews: SystematicReviews;
  readonly reviewId: string;
  readonly report: ScientSystematicReviewCombineReport;
  readonly title: (sourceId: string) => string;
  readonly searchName: (searchId: string) => string;
}) {
  const { report } = props;
  const counts = [
    report.undecidedPairs.length > 0
      ? `${plural(report.undecidedPairs.length, "duplicate pair", "duplicate pairs")} left undecided`
      : null,
    report.differingSearches.length > 0
      ? `${plural(report.differingSearches.length, "search", "searches")} with different details`
      : null,
    report.reopened.length > 0
      ? `${plural(report.reopened.length, "record", "records")} reopened`
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <div className="space-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 tabular-nums">
          {counts.length > 0
            ? `Combined with the other version: ${counts.join(", ")}.`
            : "Combined with the other version. Nothing was left to decide."}
        </span>
        {props.reviews.canResolve ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.reviews.conflictsDisabled}
            onClick={() =>
              void props.reviews.changeConflict(
                props.reviewId,
                { action: "dismiss-report" },
                "The report was not dismissed",
              )
            }
          >
            Dismiss
          </Button>
        ) : null}
      </div>
      {counts.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger className="outline-none hover:underline focus-visible:underline">
            Details
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="mt-1 space-y-0.5">
              {report.undecidedPairs.map(([first, second]) => (
                <li key={`${first}:${second}`} className="break-words">
                  Undecided: {props.title(first)} and {props.title(second)}
                </li>
              ))}
              {report.differingSearches.map((search) => (
                <li key={search.searchId} className="break-words">
                  Search {props.searchName(search.searchId)}: the other version has{" "}
                  {search.incoming.database}, {search.incoming.searchedOn}
                </li>
              ))}
              {report.reopened.map((entry) => (
                <li key={`${entry.sourceId}:${entry.stage}`} className="break-words">
                  Reopened: {props.title(entry.sourceId)} ({STAGE_WORDS[entry.stage]})
                </li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}
