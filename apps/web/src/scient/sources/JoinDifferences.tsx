import type {
  EnvironmentId,
  ScientSourcesJoinDifferenceRow,
  ScientSourcesJoinDifferences,
  ScientSourcesLibraryOrganizeAction,
} from "@t3tools/contracts";
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
import { randomUUID } from "../../lib/utils";
import { organizeScientSources, readScientSourceRecentChanges } from "./client";
import { scientSourcesErrorMessage } from "./errorMessage";
import {
  JOIN_DIFFERENCES_LABELS,
  differencesAway,
  differencesIntro,
  otherLibraryName,
  recordedParts,
  relationLabel,
  rowTitle,
  takeProblem,
} from "./joinDifferenceLabels";
import { settleAfter } from "./settleAfter";

type Take = Extract<ScientSourcesLibraryOrganizeAction, { action: "take-from-library" }>["take"];

const errorMessage = (cause: unknown) => scientSourcesErrorMessage(cause, import.meta.env.DEV);

/** Two values side by side: this Library's, and the other's. */
function Sides(props: {
  readonly label: string;
  readonly other: string;
  readonly here: string;
  readonly otherName: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{props.label}</p>
        {props.children}
      </div>
      <dl className="mt-1 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{JOIN_DIFFERENCES_LABELS.here}</dt>
          <dd className="break-words whitespace-pre-wrap">
            {props.here || JOIN_DIFFERENCES_LABELS.none}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">{props.otherName}</dt>
          <dd className="break-words whitespace-pre-wrap">
            {props.other || JOIN_DIFFERENCES_LABELS.none}
          </dd>
        </div>
      </dl>
    </div>
  );
}

interface Page {
  readonly offset: number;
  readonly listed: ScientSourcesJoinDifferences;
}

/**
 * The papers a join left as they are here because both Libraries have them, each with both
 * sides. Looking changes nothing; each action takes one thing, as an ordinary edit, and only
 * if both papers are still what the row shows.
 */
export function JoinDifferencesDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly joinId: string;
  /** False for a session that may only read: the list is shown without actions. */
  readonly canChange: boolean;
  /** Called after an action changed a paper, so the panel reads its list again. */
  readonly onChanged: () => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const { environmentId, root, joinId } = props;
  /** The pages read so far, in order; each knows where it starts and where the next does. */
  const [pages, setPages] = useState<ReadonlyArray<Page>>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const latest = useRef(0);

  const [loading, setLoading] = useState(true);
  // Reads the pages that start at `offsets` and puts each in its place; the newest request's
  // answer is the one shown. One page is read to show more, and one again after an action.
  const load = useStableCallback(async (offsets: ReadonlyArray<number>) => {
    latest.current += 1;
    const asked = latest.current;
    setLoading(true);
    try {
      const read: Page[] = [];
      for (const offset of offsets) {
        const answer = await readScientSourceRecentChanges(environmentId, {
          root,
          differencesOfJoin: { joinId, offset },
        });
        if (asked !== latest.current) return;
        if (!answer.joinDifferences) {
          setMissing(true);
          setLoading(false);
          return;
        }
        read.push({ offset, listed: answer.joinDifferences });
      }
      setPages((current) =>
        [
          ...current.filter((page) => !read.some((next) => next.offset === page.offset)),
          ...read,
        ].toSorted((left, right) => left.offset - right.offset),
      );
      setError(null);
      setLoading(false);
    } catch (cause) {
      // An answer to an older request leaves the newer one's state alone.
      if (asked !== latest.current) return;
      setError(errorMessage(cause));
      setLoading(false);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the join's recorded differences from the environment when the dialog opens
  useEffect(() => {
    void load([0]);
  }, [load]);

  const listed = pages[0]?.listed ?? null;
  const nextOffset = pages.at(-1)?.listed.nextOffset ?? null;
  const rows = pages.flatMap((page) => page.listed.rows);

  const take = (row: ScientSourcesJoinDifferenceRow, what: Take) => {
    if (!row.other) return;
    const shown = {
      here: row.here?.fingerprint ?? null,
      other: row.other.fingerprint,
      relation: row.relation,
      candidates: row.candidates.map((candidate) => candidate.sourceId),
    };
    setWorking(true);
    setNotice(null);
    void settleAfter(
      async () => {
        try {
          const result = await organizeScientSources(environmentId, {
            root,
            change: {
              action: "take-from-library",
              joinId,
              otherSourceId: row.otherSourceId,
              take: what,
              shown,
              operationId: `take_${randomUUID()}`,
            },
          });
          setNotice(takeProblem(result.outcome));
        } catch (cause) {
          setNotice(errorMessage(cause));
        }
        await props.onChanged().catch(() => undefined);
        // The page the row is on is read again; a row elsewhere that this changed is refused
        // when it is used, and read again then.
        const page = pages.find((entry) => entry.listed.rows.includes(row));
        await load([page?.offset ?? 0]);
      },
      () => setWorking(false),
    );
  };

  const otherName = listed ? otherLibraryName(listed) : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{JOIN_DIFFERENCES_LABELS.title}</DialogTitle>
          <DialogDescription>{listed ? differencesIntro(listed) : ""}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {missing ? (
            <p className="text-sm text-muted-foreground">
              The record of that addition is no longer in this Library.
            </p>
          ) : null}
          {listed && !listed.available ? (
            <p role="status" className="mb-2 text-sm break-words text-muted-foreground">
              {differencesAway(listed)}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mb-2 text-sm">
              {notice}
            </p>
          ) : null}
          {listed && rows.length === 0 && nextOffset === null ? (
            <p className="text-sm text-muted-foreground">{JOIN_DIFFERENCES_LABELS.empty}</p>
          ) : null}
          <ul className="divide-y divide-border text-sm">
            {rows.map((row) => {
              const { here, other } = row;
              const title = rowTitle(row);
              const offer = props.canChange && other !== null && listed?.available === true;
              const lackingPdfs = other
                ? other.pdfs.filter(
                    (pdf) => !(here?.pdfs ?? []).some((mine) => mine.sha256 === pdf.sha256),
                  )
                : [];
              return (
                <li key={row.otherSourceId} className="py-3">
                  <p className="font-medium break-words">{title}</p>
                  <p className="text-xs text-muted-foreground">
                    {[here?.by ?? other?.by, relationLabel(row)].filter(Boolean).join(" · ")}
                  </p>
                  {!other ? (
                    <p className="mt-1 text-xs text-muted-foreground">{recordedParts(row)}</p>
                  ) : null}
                  {other && (row.relation === "possibly-same" || row.relation === "not-here") ? (
                    <div className="mt-2 flex items-start justify-between gap-2">
                      <p className="min-w-0 text-xs break-words">
                        {otherName}: “{other.title ?? JOIN_DIFFERENCES_LABELS.untitled}”
                        {other.by ? ` (${other.by})` : ""}.{" "}
                        {row.relation === "not-here"
                          ? "It was not added then, because it looked like a paper that was here. No paper here looks like it now."
                          : "It was not added, because it may be a paper you already have."}
                      </p>
                      {offer ? (
                        <Button
                          className="shrink-0"
                          size="xs"
                          variant="outline"
                          disabled={working}
                          aria-label={`${JOIN_DIFFERENCES_LABELS.addSeparately}: ${title}`}
                          onClick={() => take(row, { kind: "add-separately" })}
                        >
                          {JOIN_DIFFERENCES_LABELS.addSeparately}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {other && here && row.parts.includes("note") ? (
                    <Sides label="Note" here={here.note} other={other.note} otherName={otherName}>
                      {offer ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={working}
                          aria-label={`${here.note ? JOIN_DIFFERENCES_LABELS.addNote : JOIN_DIFFERENCES_LABELS.useNote}: ${title}`}
                          onClick={() => take(row, { kind: "note" })}
                        >
                          {here.note
                            ? JOIN_DIFFERENCES_LABELS.addNote
                            : JOIN_DIFFERENCES_LABELS.useNote}
                        </Button>
                      ) : null}
                    </Sides>
                  ) : null}
                  {other && here && row.parts.includes("pdfs") ? (
                    <div className="mt-2">
                      <p className="text-xs font-medium">PDFs only in the other Library</p>
                      <ul className="mt-1 space-y-1 text-xs">
                        {lackingPdfs.map((pdf) => (
                          <li key={pdf.sha256} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 break-words">
                              {pdf.fileName}
                              {pdf.available ? "" : " (the file is not in that folder)"}
                            </span>
                            {offer && pdf.available ? (
                              <Button
                                className="shrink-0"
                                size="xs"
                                variant="outline"
                                disabled={working}
                                aria-label={`${JOIN_DIFFERENCES_LABELS.attach} ${pdf.fileName}: ${title}`}
                                onClick={() => take(row, { kind: "pdf", sha256: pdf.sha256 })}
                              >
                                {JOIN_DIFFERENCES_LABELS.attach}
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {other && here && row.parts.includes("tags") ? (
                    <Sides
                      label="Tags"
                      here={here.tags.join(", ")}
                      other={other.tags.join(", ")}
                      otherName={otherName}
                    />
                  ) : null}
                  {other && here && row.parts.includes("reading") ? (
                    <p className="mt-2 text-xs">
                      {[
                        other.read && !here.read ? "Read there, not here." : "",
                        other.starred && !here.starred ? "Starred there, not here." : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    </p>
                  ) : null}
                  {other && here && row.parts.includes("highlights") ? (
                    <p className="mt-2 text-xs">
                      The highlights on a PDF differ. They are not brought over; this Library's
                      stay.
                    </p>
                  ) : null}
                  {row.details.map((detail) => (
                    <Sides
                      key={detail.field}
                      label={detail.field}
                      here={detail.here}
                      other={detail.other}
                      otherName={otherName}
                    />
                  ))}
                </li>
              );
            })}
          </ul>
          {!listed && loading && !missing && !error ? (
            <p role="status" className="text-sm text-muted-foreground">
              {JOIN_DIFFERENCES_LABELS.loading}
            </p>
          ) : null}
          {nextOffset !== null ? (
            <Button
              className="mt-3"
              size="xs"
              variant="ghost"
              disabled={working || loading}
              onClick={() => void load([nextOffset])}
            >
              {loading ? JOIN_DIFFERENCES_LABELS.loading : JOIN_DIFFERENCES_LABELS.more}
            </Button>
          ) : null}
          {listed && listed.removedHere.length > 0 ? (
            <div className="mt-4">
              <p className="text-xs font-medium">{JOIN_DIFFERENCES_LABELS.removedHere}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {listed.removedHere.map((entry) => (
                  <li key={entry.otherSourceId} className="break-words">
                    {entry.title ?? JOIN_DIFFERENCES_LABELS.untitled} ·{" "}
                    {entry.state === "trash" ? "in this Library's Trash" : "deleted here"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
