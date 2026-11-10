import {
  scientReviewDecisions,
  scientReviewPendingIds,
  type ScientReviewDecision,
  type ScientReviewStage,
} from "@scientfactory/scient-sources";
import type {
  ScientSourceDetailResult,
  ScientSourcesOverviewResult,
  ScientSystematicReviewResult,
} from "@t3tools/contracts";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import type { SourcesNameRequest } from "./SourcesNameDialog";

type SourceSummary = ScientSourcesOverviewResult["records"][number];
type ReviewDetail = NonNullable<ScientSystematicReviewResult["detail"]>;

const DECISION_LABELS: Readonly<Record<ScientReviewDecision, string>> = {
  include: "Included",
  exclude: "Excluded",
  maybe: "Maybe",
};

function creatorLine(record: SourceSummary | undefined): string {
  if (!record) return "";
  const lead = record.creators[0];
  const name = lead?.familyName ?? lead?.literalName ?? lead?.givenName ?? "Unknown creator";
  return [
    record.creators.length > 1 ? `${name} et al.` : name,
    record.issuedYear,
    record.containerTitle,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One record at a time, decided with a click or I, M and E. */
export function SystematicReviewScreening(props: {
  readonly detail: ReviewDetail;
  readonly stage: ScientReviewStage;
  readonly records: ReadonlyMap<string, SourceSummary>;
  readonly sourceDetails: Readonly<Record<string, ScientSourceDetailResult | undefined>>;
  readonly loadSource: (sourceId: string) => Promise<unknown>;
  readonly pending: boolean;
  readonly onDecide: (
    sourceId: string,
    decision: ScientReviewDecision,
    reason?: string,
  ) => Promise<unknown>;
  readonly onClear: (sourceId: string) => Promise<unknown>;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onRequestName: (request: SourcesNameRequest) => void;
}) {
  const { detail, stage } = props;
  const [skipped, setSkipped] = useState<ReadonlyArray<string>>([]);
  const present = new Set(props.records.keys());
  const queue = scientReviewPendingIds(detail.review, stage, present);
  const ordered = [
    ...queue.filter((sourceId) => !skipped.includes(sourceId)),
    ...queue.filter((sourceId) => skipped.includes(sourceId)),
  ];
  const current = ordered[0] ?? null;
  const decisions = scientReviewDecisions(detail.review, stage);
  const eligible = queue.length + [...decisions.keys()].filter((id) => present.has(id)).length;
  const recent = [...decisions.values()].toReversed().slice(0, 5);
  const record = current ? props.records.get(current) : undefined;
  const sourceDetail = current ? props.sourceDetails[current] : undefined;
  const abstractReady = sourceDetail && sourceDetail.revision === record?.revision;
  const loadSource = props.loadSource;
  const needsAbstract = current !== null && !abstractReady ? current : null;
  const requested = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the current record's abstract from the environment server, once per record
  useEffect(() => {
    if (needsAbstract === null || requested.current === needsAbstract) return;
    requested.current = needsAbstract;
    void loadSource(needsAbstract).catch(() => undefined);
  }, [needsAbstract, loadSource, requested]);

  const decide = (decision: ScientReviewDecision, reason?: string) => {
    if (!current || props.pending) return;
    setSkipped((list) => list.filter((sourceId) => sourceId !== current));
    void props.onDecide(current, decision, reason);
  };
  const otherReason = () =>
    props.onRequestName({
      title: "Exclusion reason",
      label: "Reason",
      initialName: "",
      action: "Exclude",
      onSubmit: async (reason) => {
        decide("exclude", reason);
        return true;
      },
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground tabular-nums">
        {eligible === 0
          ? stage === "full-text"
            ? "Records included at title and abstract screening appear here."
            : "Log a search or add records to start screening."
          : `${eligible - queue.length} of ${eligible} decided`}
      </p>
      {current ? (
        <article
          tabIndex={0}
          aria-label="Record to screen"
          className="space-y-3 rounded-md border border-border p-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey) return;
            const key = event.key.toLowerCase();
            if (key === "i") decide("include");
            else if (key === "m") decide("maybe");
            else if (key === "e") decide("exclude");
            else return;
            event.preventDefault();
          }}
        >
          <div>
            <button
              type="button"
              className="cursor-pointer text-left text-sm font-medium outline-none hover:underline focus-visible:underline"
              onClick={() => props.onOpenSource(current)}
            >
              {record?.title ?? "Untitled source"}
            </button>
            <p className="mt-0.5 text-xs text-muted-foreground">{creatorLine(record)}</p>
          </div>
          <p className="min-h-16 whitespace-pre-line text-sm leading-relaxed text-foreground/90">
            {abstractReady ? (sourceDetail.abstract ?? "No abstract.") : null}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              disabled={props.pending}
              onClick={() => decide("include")}
            >
              Include
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.pending}
              onClick={() => decide("maybe")}
            >
              Maybe
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button type="button" size="sm" variant="outline" disabled={props.pending} />
                }
              >
                Exclude
                <ChevronDown />
              </MenuTrigger>
              <MenuPopup align="start" side="bottom" className="min-w-48">
                {detail.review.exclusionReasons.map((reason) => (
                  <MenuItem key={reason} onClick={() => decide("exclude", reason)}>
                    {reason}
                  </MenuItem>
                ))}
                <MenuItem onClick={otherReason}>Other reason…</MenuItem>
                <MenuSeparator />
                <MenuItem onClick={() => decide("exclude")}>Exclude without a reason</MenuItem>
              </MenuPopup>
            </Menu>
            {ordered.length > 1 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost-muted"
                className="ms-auto"
                onClick={() =>
                  setSkipped((list) => [...list.filter((id) => id !== current), current])
                }
              >
                Skip
              </Button>
            ) : null}
          </div>
        </article>
      ) : eligible > 0 ? (
        <p className="text-sm text-muted-foreground">Every record at this stage has a decision.</p>
      ) : null}
      {recent.length > 0 ? (
        <section className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent decisions
          </h3>
          <ul className="divide-y divide-border">
            {recent.map((entry) => (
              <li key={entry.sourceId} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {props.records.get(entry.sourceId)?.title ?? "Untitled source"}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {DECISION_LABELS[entry.decision]}
                  {entry.reason ? ` · ${entry.reason}` : ""}
                  {entry.decidedBy === "agent" ? " · by agent" : ""}
                </span>
                <Button
                  type="button"
                  size="compact"
                  variant="ghost-muted"
                  disabled={props.pending}
                  onClick={() => void props.onClear(entry.sourceId)}
                >
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
