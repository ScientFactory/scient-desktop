import { T, useGT } from "gt-react";
import type {
  LiteratureWatchBriefing,
  LiteratureWatchItem,
  LiteratureWatchService,
} from "@scientfactory/scient-sources";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronLeft, LoaderCircle, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { ContextualConfirmation } from "../../components/ui/contextual-confirmation";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { toastManager } from "../../components/ui/toast";
import { useStableCallback } from "../../hooks/useStableCallback";
import { readLocalApi } from "../../localApi";
import { SOURCES_COLUMN } from "./PanelChrome";
import { useLiteratureWatch, type LiteratureWatchList } from "./useLiteratureWatches";

const FEATURED = 8;

const SERVICE_NAMES: Record<LiteratureWatchService, string> = {
  pubmed: "PubMed",
  openalex: "OpenAlex",
  arxiv: "arXiv",
};

const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: iso.length === 10 ? "UTC" : undefined,
  });

function itemUrl(item: LiteratureWatchItem): string | null {
  const { ids } = item.candidate;
  if (ids.doi) return `https://doi.org/${ids.doi}`;
  if (ids.arxiv) return `https://arxiv.org/abs/${ids.arxiv}`;
  if (ids.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${ids.pmid}/`;
  if (ids.openalex) return `https://openalex.org/${ids.openalex}`;
  return null;
}

function byline(item: LiteratureWatchItem): string {
  const { authors, authorCount, venue, published } = item.candidate;
  const first = authors[0];
  const who = first ? (authorCount > 1 ? `${first} et al.` : first) : null;
  return [who, venue, published ? day(published) : null].filter(Boolean).join(" · ");
}

type Change = ReturnType<typeof useLiteratureWatch>["change"];

function BriefingItem(props: {
  readonly briefingId: string;
  readonly item: LiteratureWatchItem;
  readonly change: Change;
  readonly busy: boolean;
  readonly canChange: boolean;
  readonly onOpenSource: (sourceId: string) => void;
}) {
  const gt = useGT();
  const { item } = props;
  const target = { briefingId: props.briefingId, candidateId: item.candidate.candidateId };
  const url = itemUrl(item);
  const triage = item.triage;
  const evidence =
    item.evidence === "title"
      ? gt("Title only")
      : item.evidence === "full-text"
        ? gt("Full text")
        : gt("Abstract", { $context: "what a paper summary was based on" });
  const keep = async () => {
    const result = await props.change(
      `keep:${target.candidateId}`,
      { action: "keep", ...target },
      gt("Not kept"),
    );
    const kept = result?.kept;
    if (kept && kept.outcome !== "imported" && kept.outcome !== "duplicate") {
      toastManager.add({
        type: "error",
        title: gt("Not kept"),
        description:
          kept.outcome === "not-found"
            ? gt("Its identifier was not found.")
            : gt("The registry did not answer. Try again."),
      });
    }
  };
  return (
    <li className={`py-3 ${triage?.action === "dismissed" ? "opacity-55" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {url ? (
            <button
              type="button"
              className="cursor-pointer text-left text-sm font-medium hover:underline"
              onClick={() => void readLocalApi()?.shell.openExternal(url)}
            >
              {item.candidate.title}
            </button>
          ) : (
            <span className="text-sm font-medium">{item.candidate.title}</span>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {byline(item)}
            {" · "}
            {evidence}
          </p>
          <p className="mt-1.5 text-sm">{item.why}</p>
          {item.details.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {item.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {props.canChange ? (
          <div className="flex shrink-0 items-center gap-1">
            {triage?.action === "kept" ? (
              <>
                {triage.sourceId ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => props.onOpenSource(triage.sourceId!)}
                  >
                    <T>Kept</T>
                  </Button>
                ) : null}
              </>
            ) : triage?.action === "dismissed" ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={props.busy}
                onClick={() =>
                  void props.change(
                    `clear:${target.candidateId}`,
                    { action: "clear", ...target },
                    gt("Not restored"),
                  )
                }
              >
                {gt("Undo", { $context: "verb, button that undoes a change" })}
              </Button>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.busy}
                  onClick={() => void keep()}
                >
                  {gt("Keep", { $context: "verb, add a paper to the Library" })}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() =>
                    void props.change(
                      `dismiss:${target.candidateId}`,
                      { action: "dismiss", ...target },
                      gt("Not dismissed"),
                    )
                  }
                >
                  {gt("Dismiss", { $context: "verb, hide a suggested paper" })}
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Briefing(props: {
  readonly briefing: LiteratureWatchBriefing;
  readonly change: Change;
  readonly pending: string | null;
  readonly canChange: boolean;
  readonly onOpenSource: (sourceId: string) => void;
}) {
  const gt = useGT();
  const [showMore, setShowMore] = useState(false);
  const { briefing } = props;
  const featured = briefing.items.slice(0, FEATURED);
  const more = briefing.items.slice(FEATURED);
  const failed = briefing.services.filter((service) => service.status !== "complete");
  const from = briefing.services.map((service) => service.from).toSorted()[0];
  const item = (entry: LiteratureWatchItem) => (
    <BriefingItem
      key={entry.candidate.candidateId}
      briefingId={briefing.briefingId}
      item={entry}
      change={props.change}
      busy={props.pending !== null}
      canChange={props.canChange}
      onOpenSource={props.onOpenSource}
    />
  );
  return (
    <section className="space-y-2">
      {briefing.summary ? (
        <p className="text-sm text-muted-foreground">{briefing.summary}</p>
      ) : null}
      {featured.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <T>Nothing new this time.</T>
        </p>
      ) : (
        <ul className="divide-y divide-border">{featured.map(item)}</ul>
      )}
      {more.length > 0 ? (
        <div>
          <Button size="xs" variant="ghost" onClick={() => setShowMore((open) => !open)}>
            {gt("{count, plural, =1 {1 more match} other {{count} more matches}}", {
              count: more.length,
            })}
          </Button>
          {showMore ? <ul className="divide-y divide-border">{more.map(item)}</ul> : null}
        </div>
      ) : null}
      <p className="pt-2 text-xs text-muted-foreground tabular-nums">
        {gt("{services} · {from}–{to} · {count} screened", {
          services: briefing.services.map((service) => SERVICE_NAMES[service.service]).join(", "),
          from: from ? day(from) : "",
          to: day(briefing.publishedAt),
          count: briefing.screened,
        })}
      </p>
      {failed.map((service) => (
        <p key={service.service} className="text-xs text-warning-foreground">
          {service.status === "failed"
            ? gt("{service} did not answer; the next run searches these days again.", {
                service: SERVICE_NAMES[service.service],
              })
            : gt("{service} had more than one run reads; narrow the watch.", {
                service: SERVICE_NAMES[service.service],
              })}
        </p>
      ))}
    </section>
  );
}

export function LiteratureWatchesView(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly list: LiteratureWatchList;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onBack: () => void;
}) {
  const gt = useGT();
  const [watchId, setWatchId] = useState<string | null>(null);
  const [briefingId, setBriefingId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const opened = useLiteratureWatch({
    environmentId: props.environmentId,
    root: props.root,
    watchId,
    onListChanged: () => void props.list.reload(),
  });
  const watch = opened.watch;
  const briefing =
    watch?.briefings.find((entry) => entry.briefingId === briefingId) ??
    watch?.briefings[0] ??
    null;
  const summaries = props.list.list?.watches ?? [];

  const unreadShown =
    briefing && !briefing.openedAt && opened.canChange ? briefing.briefingId : null;
  const markOpened = useStableCallback((id: string) => {
    void opened.change("opened", { action: "opened", briefingId: id }, gt("Not saved"));
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the environment server that the briefing on screen has been read
  useEffect(() => {
    if (unreadShown) markOpened(unreadShown);
  }, [unreadShown, markOpened]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            if (watchId) {
              setWatchId(null);
              setBriefingId(null);
            } else props.onBack();
          }}
        >
          <ChevronLeft />
          {watchId ? gt("Watches") : gt("Library", { $context: "the personal Library of sources" })}
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {watchId ? (watch?.title ?? "") : gt("Watches")}
        </h2>
        {watch?.running ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" />
            <T>Running</T>
          </span>
        ) : null}
        {watch && opened.canChange ? (
          <>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    ref={menuTrigger}
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={gt("Watch actions")}
                  />
                }
              >
                <MoreHorizontal />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem
                  disabled={opened.pending !== null || watch.running}
                  onClick={() =>
                    void opened.change("run-now", { action: "run-now" }, gt("Did not start"))
                  }
                >
                  <T>Run now</T>
                </MenuItem>
                <MenuItem
                  disabled={opened.pending !== null}
                  onClick={() =>
                    void opened.change(
                      "pause",
                      { action: watch.paused ? "resume" : "pause" },
                      gt("Not changed"),
                    )
                  }
                >
                  {watch.paused
                    ? gt("Resume", { $context: "verb, restart a paused watch" })
                    : gt("Pause")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                  <T>Delete watch</T>
                </MenuItem>
              </MenuPopup>
            </Menu>
            <ContextualConfirmation
              open={confirmingDelete}
              onOpenChange={setConfirmingDelete}
              anchor={menuTrigger}
              title={gt("Delete “{title}”?", { title: watch.title })}
              description={gt("Kept papers stay in the Library.")}
              confirmLabel={gt("Delete")}
              destructive
              onConfirm={() =>
                void opened
                  .change("delete", { action: "delete" }, gt("Watch was not deleted"))
                  .then((result) => {
                    if (result) setWatchId(null);
                  })
              }
            />
          </>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={`${SOURCES_COLUMN} space-y-4 p-4`}>
          {opened.error && watchId ? (
            <p className="text-sm text-destructive-foreground">{opened.error}</p>
          ) : null}
          {!watchId ? (
            props.list.list === null ? null : summaries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <T>No watches yet. Ask in a chat to watch a topic.</T>
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {summaries.map((entry) => (
                  <li key={entry.watchId}>
                    <button
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => {
                        setBriefingId(null);
                        setWatchId(entry.watchId);
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{entry.title}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                          {entry.paused
                            ? gt("Paused")
                            : entry.everyDays === 7
                              ? gt("Weekly")
                              : entry.everyDays === 1
                                ? gt("Daily")
                                : gt("Every {count} days", { count: entry.everyDays })}
                          {entry.lastBriefingAt
                            ? gt(" · {date}", { date: day(entry.lastBriefingAt) })
                            : null}
                        </span>
                      </span>
                      {entry.unread > 0 ? (
                        <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums">
                          {entry.unread}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : watch ? (
            <>
              {briefing ? (
                <Briefing
                  key={briefing.briefingId}
                  briefing={briefing}
                  change={opened.change}
                  pending={opened.pending}
                  canChange={opened.canChange}
                  onOpenSource={props.onOpenSource}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {watch.running ? (
                    <T>The first briefing is on its way.</T>
                  ) : (
                    <T>No briefings yet.</T>
                  )}
                </p>
              )}
              {watch.briefings.length > 1 ? (
                <section className="border-t border-border pt-3">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    <T>Earlier</T>
                  </h3>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {watch.briefings.map((entry) => (
                      <Button
                        key={entry.briefingId}
                        size="xs"
                        variant={entry.briefingId === briefing?.briefingId ? "secondary" : "ghost"}
                        onClick={() => setBriefingId(entry.briefingId)}
                      >
                        {day(entry.publishedAt)}
                      </Button>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
