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
import type { SystematicReviews } from "./useSystematicReviews";

type Version = ScientSystematicReviewConflictsResult["versions"][number];
type Pick = "keep" | "use-other" | "combine";

const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
};
const plural = (value: number, one: string, many: string) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;

function VersionSummary(props: { readonly heading: string; readonly version: Version | null }) {
  const { version } = props;
  return (
    <div className="min-w-0 space-y-1 rounded-md bg-muted/40 p-3 text-sm">
      <p className="text-xs text-muted-foreground">{props.heading}</p>
      {version ? (
        <>
          <p className="break-words font-medium">{version.title}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            Changed {date(version.updatedAt)}{" "}
            {version.updatedBy === "agent" ? "by an agent" : "by you"}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {plural(version.searches, "search", "searches")} ·{" "}
            {plural(version.records, "record", "records")} ·{" "}
            {plural(version.decisions, "decision", "decisions")}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {version.lastDecidedAt
              ? `Last decision ${date(version.lastDecidedAt)}`
              : "No decisions yet"}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This version could not be read.</p>
      )}
    </div>
  );
}

/** Both versions of a review side by side, with the choice between them. */
function ReviewVersionsDialog(props: {
  readonly versions: ScientSystematicReviewConflictsResult | null;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onChoose: (conflictId: string, pick: Pick) => void;
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
              {props.versions.versions.map((version) => (
                <section key={version.conflictId} className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <VersionSummary heading="This version" version={props.versions!.current} />
                    <VersionSummary heading="The other version" version={version} />
                  </div>
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
                    Combine keeps the searches and records of both versions, and reopens any record
                    the two decided differently.
                  </p>
                </section>
              ))}
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
  const [error, setError] = useState<string | null>(null);
  // A choice is offered only on versions read after the last opening and the last choice.
  const [reading, setReading] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const latestRead = useRef(0);
  const load = async () => {
    latestRead.current += 1;
    const read = latestRead.current;
    setReading(true);
    const next = await props.reviews.readConflicts(props.reviewId).catch((cause: unknown) => {
      if (read === latestRead.current) {
        setError(scientSourcesErrorMessage(cause, import.meta.env.DEV));
      }
      return null;
    });
    if (read !== latestRead.current) return;
    setReading(false);
    if (!next) return;
    setError(null);
    setVersions(next);
    if (next.versions.length === 0) setOpen(false);
  };
  const choose = async (conflictId: string, pick: Pick) => {
    setChoosing(true);
    const current = versions?.current;
    const changed = await props.reviews.changeConflict(
      props.reviewId,
      {
        action: "resolve",
        conflictId,
        pick,
        ...(current ? { currentUpdatedAt: current.updatedAt } : {}),
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
        className="block w-full cursor-pointer text-left text-sm text-muted-foreground outline-none hover:underline focus-visible:underline"
        onClick={() => {
          setOpen(true);
          setVersions(null);
          setError(null);
          void load();
        }}
      >
        This review has another version from a copy of this project.
      </button>
      {open ? (
        <ReviewVersionsDialog
          versions={versions}
          error={error}
          disabled={props.reviews.conflictsDisabled || reading || choosing}
          onChoose={(conflictId, pick) => void choose(conflictId, pick)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

const STAGE_WORDS = { "title-abstract": "title and abstract", "full-text": "full text" } as const;

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
