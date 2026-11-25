import type {
  EnvironmentId,
  ScientSourcesJoinDifferenceRow,
  ScientSourcesJoinDifferences,
  ScientSourcesLibraryOrganizeAction,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
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
import { sourcesErrorMessage } from "./errorMessage";
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
import { Sides } from "./Sides";

type Take = Extract<ScientSourcesLibraryOrganizeAction, { action: "take-from-library" }>["take"];

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
  const gt = useGT();
  const m = useMessages();
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
      setError(sourcesErrorMessage(cause));
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
          setNotice(sourcesErrorMessage(cause));
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

  const otherName = listed ? otherLibraryName(listed, m) : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m(JOIN_DIFFERENCES_LABELS.title)}</DialogTitle>
          <DialogDescription>{listed ? differencesIntro(listed, m) : ""}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {missing ? (
            <p className="text-sm text-muted-foreground">
              <T>The record of that addition is no longer in this Library.</T>
            </p>
          ) : null}
          {listed && !listed.available ? (
            <p role="status" className="mb-2 text-sm break-words text-muted-foreground">
              {differencesAway(listed, m)}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="mb-2 text-sm">
              {notice}
            </p>
          ) : null}
          {listed && rows.length === 0 && nextOffset === null ? (
            <p className="text-sm text-muted-foreground">{m(JOIN_DIFFERENCES_LABELS.empty)}</p>
          ) : null}
          <ul className="divide-y divide-border text-sm">
            {rows.map((row) => {
              const { here, other } = row;
              const title = rowTitle(row, m);
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
                    {[here?.by ?? other?.by, relationLabel(row, m)].filter(Boolean).join(" · ")}
                  </p>
                  {!other ? (
                    <p className="mt-1 text-xs text-muted-foreground">{recordedParts(row, m)}</p>
                  ) : null}
                  {other && (row.relation === "possibly-same" || row.relation === "not-here") ? (
                    <div className="mt-2 flex items-start justify-between gap-2">
                      <p className="min-w-0 text-xs break-words">
                        {row.relation === "not-here"
                          ? gt(
                              "{library}: “{title}”{hasBy, select, yes { ({by})} other {}}. It was not added then, because it looked like a paper that was here. No paper here looks like it now.",
                              {
                                library: otherName,
                                title: other.title ?? m(JOIN_DIFFERENCES_LABELS.untitled),
                                hasBy: other.by ? "yes" : "no",
                                by: other.by ?? "",
                              },
                            )
                          : gt(
                              "{library}: “{title}”{hasBy, select, yes { ({by})} other {}}. It was not added, because it may be a paper you already have.",
                              {
                                library: otherName,
                                title: other.title ?? m(JOIN_DIFFERENCES_LABELS.untitled),
                                hasBy: other.by ? "yes" : "no",
                                by: other.by ?? "",
                              },
                            )}
                      </p>
                      {offer ? (
                        <Button
                          className="shrink-0"
                          size="xs"
                          variant="outline"
                          disabled={working}
                          aria-label={gt("Add separately: {title}", { title })}
                          onClick={() => take(row, { kind: "add-separately" })}
                        >
                          {m(JOIN_DIFFERENCES_LABELS.addSeparately)}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {other && here && row.parts.includes("note") ? (
                    <Sides
                      label={gt("Note", {
                        $context: "a paper's note, compared between two Libraries",
                      })}
                      here={here.note}
                      other={other.note}
                      hereName={m(JOIN_DIFFERENCES_LABELS.here)}
                      otherName={otherName}
                    >
                      {offer ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={working}
                          aria-label={
                            here.note
                              ? gt("Add to my note: {title}", { title })
                              : gt("Use this note: {title}", { title })
                          }
                          onClick={() => take(row, { kind: "note" })}
                        >
                          {here.note
                            ? m(JOIN_DIFFERENCES_LABELS.addNote)
                            : m(JOIN_DIFFERENCES_LABELS.useNote)}
                        </Button>
                      ) : null}
                    </Sides>
                  ) : null}
                  {other && here && row.parts.includes("pdfs") ? (
                    <div className="mt-2">
                      <p className="text-xs font-medium">
                        <T>PDFs only in the other Library</T>
                      </p>
                      <ul className="mt-1 space-y-1 text-xs">
                        {lackingPdfs.map((pdf) => (
                          <li key={pdf.sha256} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 break-words">
                              {pdf.available
                                ? pdf.fileName
                                : gt("{fileName} (the file is not in that folder)", {
                                    fileName: pdf.fileName,
                                  })}
                            </span>
                            {offer && pdf.available ? (
                              <Button
                                className="shrink-0"
                                size="xs"
                                variant="outline"
                                disabled={working}
                                aria-label={gt("Attach {fileName}: {title}", {
                                  fileName: pdf.fileName,
                                  title,
                                })}
                                onClick={() => take(row, { kind: "pdf", sha256: pdf.sha256 })}
                              >
                                {m(JOIN_DIFFERENCES_LABELS.attach)}
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {other && here && row.parts.includes("tags") ? (
                    <Sides
                      label={gt("Tags", { $context: "noun" })}
                      here={here.tags.join(", ")}
                      other={other.tags.join(", ")}
                      hereName={m(JOIN_DIFFERENCES_LABELS.here)}
                      otherName={otherName}
                    />
                  ) : null}
                  {other && here && row.parts.includes("reading") ? (
                    <p className="mt-2 text-xs">
                      {[
                        other.read && !here.read ? gt("Read there, not here.") : "",
                        other.starred && !here.starred ? gt("Starred there, not here.") : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    </p>
                  ) : null}
                  {other && here && row.parts.includes("highlights") ? (
                    <p className="mt-2 text-xs">
                      <T>
                        The highlights on a PDF differ. They are not brought over; this Library's
                        stay.
                      </T>
                    </p>
                  ) : null}
                  {row.details.map((detail) => (
                    <Sides
                      key={detail.field}
                      label={detail.field}
                      here={detail.here}
                      other={detail.other}
                      hereName={m(JOIN_DIFFERENCES_LABELS.here)}
                      otherName={otherName}
                    />
                  ))}
                </li>
              );
            })}
          </ul>
          {!listed && loading && !missing && !error ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m(JOIN_DIFFERENCES_LABELS.loading)}
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
              {loading ? m(JOIN_DIFFERENCES_LABELS.loading) : m(JOIN_DIFFERENCES_LABELS.more)}
            </Button>
          ) : null}
          {listed && listed.removedHere.length > 0 ? (
            <div className="mt-4">
              <p className="text-xs font-medium">{m(JOIN_DIFFERENCES_LABELS.removedHere)}</p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {listed.removedHere.map((entry) => (
                  <li key={entry.otherSourceId} className="break-words">
                    {entry.state === "trash"
                      ? gt("{title} · in this Library's Trash", {
                          title: entry.title ?? m(JOIN_DIFFERENCES_LABELS.untitled),
                        })
                      : gt("{title} · deleted here", {
                          title: entry.title ?? m(JOIN_DIFFERENCES_LABELS.untitled),
                        })}
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
