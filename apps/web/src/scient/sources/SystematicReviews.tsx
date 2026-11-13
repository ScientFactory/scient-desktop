import type { ScientReviewStage, ScientSourcesOrganization } from "@scientfactory/scient-sources";
import type {
  EnvironmentId,
  ScientSourceDetailResult,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { ChevronLeft, Copy, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { PrismaDiagram } from "./PrismaDiagram";
import { CombineReportNotice, ReviewVersionsLine } from "./ReviewVersions";
import { SourcesNameDialog, type SourcesNameRequest } from "./SourcesNameDialog";
import { SystematicReviewScreening, type ReviewRecordView } from "./SystematicReviewScreening";
import {
  readLastReviewPlace,
  rememberReviewPlace,
  useSystematicReviews,
  type SystematicReviews,
} from "./useSystematicReviews";

type SourceSummary = ScientSourcesOverviewResult["records"][number];
type Tab = "records" | "screening" | "prisma";

function SectionTitle(props: { readonly children: string }) {
  return (
    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {props.children}
    </h3>
  );
}

function localToday(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

const NO_RECORDS = "none";
const SELECTED = "selected";

function LogSearchDialog(props: {
  readonly open: boolean;
  readonly reviews: SystematicReviews;
  readonly reviewId: string;
  readonly organization: ScientSourcesOrganization;
  readonly selectedSourceIds: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  const [database, setDatabase] = useState("");
  const [query, setQuery] = useState("");
  const [searchedOn, setSearchedOn] = useState(localToday);
  const [resultCount, setResultCount] = useState("");
  const [records, setRecords] = useState<string>(
    props.selectedSourceIds.length > 0 ? SELECTED : NO_RECORDS,
  );
  const choices = [
    { value: NO_RECORDS, label: "Add records later" },
    ...(props.selectedSourceIds.length > 0
      ? [{ value: SELECTED, label: `Selected sources (${props.selectedSourceIds.length})` }]
      : []),
    ...props.organization.collections.map((collection) => ({
      value: collection.collectionId,
      label: `${collection.name} (${collection.sourceIds.length})`,
    })),
  ];
  const count = resultCount.trim() ? Number.parseInt(resultCount, 10) : undefined;
  const valid = database.trim() && searchedOn.trim() && (count === undefined || count >= 0);
  const submit = async () => {
    if (!valid) return;
    const result = await props.reviews.change(
      {
        action: "log-search",
        reviewId: props.reviewId,
        database: database.trim(),
        query,
        searchedOn: searchedOn.trim(),
        ...(count !== undefined && Number.isFinite(count) ? { resultCount: count } : {}),
        ...(records === SELECTED ? { sourceIds: props.selectedSourceIds } : {}),
        ...(records !== SELECTED && records !== NO_RECORDS ? { collectionId: records } : {}),
      },
      "Search was not logged",
    );
    if (result) props.onClose();
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Log a search</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Field>
              <FieldLabel>Database</FieldLabel>
              <Input
                autoFocus
                value={database}
                placeholder="PubMed"
                maxLength={200}
                onChange={(event) => setDatabase(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Search string</FieldLabel>
              <Textarea
                value={query}
                rows={3}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel>Date searched</FieldLabel>
                <Input
                  type="date"
                  value={searchedOn}
                  onChange={(event) => setSearchedOn(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel>Results reported</FieldLabel>
                <Input
                  inputMode="numeric"
                  value={resultCount}
                  placeholder="Optional"
                  onChange={(event) => setResultCount(event.target.value.replace(/\D/gu, ""))}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel>Records from this search</FieldLabel>
              <Select
                value={records}
                items={choices}
                onValueChange={(value) => setRecords(String(value))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!valid || props.reviews.disabled}
            onClick={() => void submit()}
          >
            Log search
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function EditReviewDialog(props: {
  readonly reviews: SystematicReviews;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const review = props.reviews.detail?.review;
  const [title, setTitle] = useState(review?.title ?? "");
  const [question, setQuestion] = useState(review?.question ?? "");
  const [reasons, setReasons] = useState((review?.exclusionReasons ?? []).join("\n"));
  if (!review) return null;
  const submit = async () => {
    const result = await props.reviews.change(
      {
        action: "update-review",
        reviewId: review.reviewId,
        ...(title.trim() ? { title: title.trim() } : {}),
        question,
        exclusionReasons: [
          ...new Set(
            reasons
              .split(/\r?\n/u)
              .map((reason) => reason.trim())
              .filter(Boolean),
          ),
        ].slice(0, 50),
      },
      "Review was not saved",
    );
    if (result) props.onClose();
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit review</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Field>
              <FieldLabel>Title</FieldLabel>
              <Input
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Review question</FieldLabel>
              <Textarea
                value={question}
                rows={3}
                placeholder="Population, intervention, comparator, outcomes"
                onChange={(event) => setQuestion(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Exclusion reasons, one per line</FieldLabel>
              <Textarea
                value={reasons}
                rows={6}
                onChange={(event) => setReasons(event.target.value)}
              />
            </Field>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!title.trim() || props.reviews.disabled}
            onClick={() => void submit()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RecordsTab(props: {
  readonly reviews: SystematicReviews;
  readonly records: ReadonlyMap<string, ReviewRecordView>;
  readonly organization: ScientSourcesOrganization;
  readonly selectedSourceIds: ReadonlyArray<string>;
  readonly onOpenSource: (sourceId: string) => void;
}) {
  const detail = props.reviews.detail!;
  const reviewId = detail.review.reviewId;
  const [logging, setLogging] = useState(false);
  const title = (sourceId: string) => props.records.get(sourceId)?.title ?? "Untitled source";
  const addInBatches = async (sourceIds: ReadonlyArray<string>) => {
    for (let start = 0; start < sourceIds.length; start += 500) {
      const result = await props.reviews.change(
        { action: "add-sources", reviewId, sourceIds: sourceIds.slice(start, start + 500) },
        "Records were not added",
      );
      if (!result) return;
    }
  };
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <SectionTitle>Searches</SectionTitle>
          <Button
            type="button"
            size="compact"
            variant="ghost-muted"
            className="ms-auto"
            disabled={props.reviews.disabled}
            onClick={() => setLogging(true)}
          >
            <Plus />
            Log search
          </Button>
        </div>
        {detail.review.searches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No searches logged yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {detail.review.searches.map((search) => (
              <li key={search.searchId} className="flex items-start gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {search.database}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {" · "}
                      {search.searchedOn}
                      {search.resultCount !== undefined ? ` · ${search.resultCount} results` : ""}
                      {` · ${search.sourceIds.length} records`}
                      {search.loggedBy === "agent" ? " · by agent" : ""}
                    </span>
                  </p>
                  {search.query ? (
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {search.query}
                    </p>
                  ) : null}
                </div>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Search actions"
                      />
                    }
                  >
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      variant="destructive"
                      disabled={props.reviews.disabled}
                      onClick={() =>
                        void props.reviews.change(
                          { action: "remove-search", reviewId, searchId: search.searchId },
                          "Search was not removed",
                        )
                      }
                    >
                      Remove search
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <SectionTitle>Records found another way</SectionTitle>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="compact"
                  variant="ghost-muted"
                  className="ms-auto"
                  disabled={props.reviews.disabled}
                />
              }
            >
              <Plus />
              Add records
            </MenuTrigger>
            <MenuPopup align="end" className="min-w-48">
              {props.selectedSourceIds.length > 0 ? (
                <MenuItem onClick={() => void addInBatches(props.selectedSourceIds)}>
                  Selected sources ({props.selectedSourceIds.length})
                </MenuItem>
              ) : null}
              {props.organization.collections
                .filter((collection) => collection.sourceIds.length > 0)
                .map((collection) => (
                  <MenuItem
                    key={collection.collectionId}
                    onClick={() => void addInBatches(collection.sourceIds)}
                  >
                    {collection.name} ({collection.sourceIds.length})
                  </MenuItem>
                ))}
              {props.selectedSourceIds.length === 0 &&
              props.organization.collections.every(
                (collection) => collection.sourceIds.length === 0,
              ) ? (
                <MenuItem disabled>Select sources or make a collection first</MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
        <p className="text-sm text-muted-foreground tabular-nums">
          {detail.prisma.identified.otherMethods === 0
            ? "None, such as citation searching or a colleague’s suggestion."
            : `${detail.prisma.identified.otherMethods} records`}
        </p>
      </section>
      {detail.possibleDuplicates.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle>Possible duplicates</SectionTitle>
          <ul className="divide-y divide-border">
            {detail.possibleDuplicates.map(([first, second]) => (
              <li key={`${first}:${second}`} className="space-y-1.5 py-2 text-sm">
                {[first, second].map((sourceId) => (
                  <button
                    key={sourceId}
                    type="button"
                    className="block w-full cursor-pointer truncate text-left outline-none hover:underline focus-visible:underline"
                    onClick={() => props.onOpenSource(sourceId)}
                  >
                    {title(sourceId)}
                    <span className="text-xs text-muted-foreground">
                      {props.records.get(sourceId)?.issuedYear
                        ? ` · ${props.records.get(sourceId)?.issuedYear}`
                        : ""}
                    </span>
                  </button>
                ))}
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="compact"
                    variant="outline"
                    disabled={props.reviews.disabled}
                    onClick={() =>
                      void props.reviews.change(
                        {
                          action: "mark-duplicate",
                          reviewId,
                          sourceId: second,
                          duplicateOf: first,
                        },
                        "Duplicate was not removed",
                      )
                    }
                  >
                    Keep first
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    variant="outline"
                    disabled={props.reviews.disabled}
                    onClick={() =>
                      void props.reviews.change(
                        {
                          action: "mark-duplicate",
                          reviewId,
                          sourceId: first,
                          duplicateOf: second,
                        },
                        "Duplicate was not removed",
                      )
                    }
                  >
                    Keep second
                  </Button>
                  <Button
                    type="button"
                    size="compact"
                    variant="ghost-muted"
                    disabled={props.reviews.disabled}
                    onClick={() =>
                      void props.reviews.change(
                        { action: "mark-distinct", reviewId, sourceIds: [first, second] },
                        "Pair was not dismissed",
                      )
                    }
                  >
                    Not duplicates
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {detail.review.duplicates.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle>Removed duplicates</SectionTitle>
          <ul className="divide-y divide-border">
            {detail.review.duplicates.map((entry) => (
              <li key={entry.sourceId} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{title(entry.sourceId)}</span>
                <Button
                  type="button"
                  size="compact"
                  variant="ghost-muted"
                  disabled={props.reviews.disabled}
                  onClick={() =>
                    void props.reviews.change(
                      { action: "unmark-duplicate", reviewId, sourceId: entry.sourceId },
                      "Record was not restored",
                    )
                  }
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <LogSearchDialog
        key={logging ? "open" : "closed"}
        open={logging}
        reviews={props.reviews}
        reviewId={reviewId}
        organization={props.organization}
        selectedSourceIds={props.selectedSourceIds}
        onClose={() => setLogging(false)}
      />
    </div>
  );
}

function PrismaTab(props: { readonly reviews: SystematicReviews }) {
  const detail = props.reviews.detail!;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "PRISMA diagram" });
  return (
    <div className="space-y-3">
      <PrismaDiagram prisma={detail.prisma} />
      <Button
        type="button"
        size="compact"
        variant="ghost-muted"
        onClick={() => copyToClipboard(`\`\`\`mermaid\n${detail.mermaid}\n\`\`\``)}
      >
        <Copy />
        {isCopied ? "Copied" : "Copy as Mermaid"}
      </Button>
    </div>
  );
}

/** Systematic reviews over the Library: searches, duplicates, screening and the PRISMA flow. */
export function SystematicReviewsView(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly organization: ScientSourcesOrganization;
  readonly selectedSourceIds: ReadonlyArray<string>;
  readonly sourceDetails: Readonly<Record<string, ScientSourceDetailResult | undefined>>;
  readonly loadSource: (sourceId: string, reviewId?: string) => Promise<unknown>;
  readonly onOpenSource: (sourceId: string) => void;
  readonly onBack: () => void;
}) {
  const reviews = useSystematicReviews({ environmentId: props.environmentId, root: props.root });
  const context = `${props.environmentId}\0${props.root}`;
  const [place] = useState(() => readLastReviewPlace(context));
  const [tab, setTabState] = useState<Tab>(
    place.tab === "screening" || place.tab === "prisma" ? place.tab : "records",
  );
  const [stage, setStageState] = useState<ScientReviewStage>(
    place.stage === "full-text" ? "full-text" : "title-abstract",
  );
  const setTab = (next: Tab) => {
    rememberReviewPlace(context, { tab: next });
    setTabState(next);
  };
  const setStage = (next: ScientReviewStage) => {
    rememberReviewPlace(context, { stage: next });
    setStageState(next);
  };
  const [nameRequest, setNameRequest] = useState<SourcesNameRequest | null>(null);
  const [editing, setEditing] = useState(false);
  // A library server names a review's records by the IDs the review stores.
  const records = new Map<string, ReviewRecordView>(
    (reviews.records ?? props.records).map((record) => [record.sourceId, record]),
  );
  const reviewRecordsId = reviews.records ? reviews.detail?.review.reviewId : undefined;
  const loadSource = (sourceId: string) => props.loadSource(sourceId, reviewRecordsId);
  // A record served from the review's snapshot is in no list, so its details are read first.
  const openSource = (sourceId: string) => {
    if (records.get(sourceId)?.label !== "From this review's snapshot") {
      props.onOpenSource(sourceId);
      return;
    }
    void loadSource(sourceId).then(
      () => props.onOpenSource(sourceId),
      () => undefined,
    );
  };
  const detail = reviews.detail;
  const openId = reviews.reviewId;
  const openSummary = reviews.list?.reviews.find((review) => review.reviewId === openId) ?? null;

  const newReview = () =>
    setNameRequest({
      title: "New systematic review",
      label: "Review title",
      initialName: "",
      action: "Create",
      onSubmit: async (title) => {
        const result = await reviews.change(
          { action: "create-review", title },
          "Review was not created",
        );
        if (result?.reviewId) reviews.open(result.reviewId);
        return result !== null;
      },
    });
  const deleteReview = async (reviewId: string, title: string) => {
    const result = await reviews.change(
      { action: "delete-review", reviewId },
      "Review was not deleted",
    );
    if (result?.outcome !== "deleted") return;
    reviews.open(null);
    toastManager.add({
      type: "success",
      title: `Deleted review “${title}”`,
      description: "Its sources stay in the Library.",
      actionProps: {
        children: "Undo",
        onClick: () => {
          void reviews.change({ action: "restore-review", reviewId }, "Review was not restored");
        },
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
        <Button
          variant="ghost"
          size="xs"
          onClick={() => (openId ? reviews.open(null) : props.onBack())}
          aria-label={openId ? "Back to reviews" : "Back to Library"}
        >
          <ChevronLeft />
          {openId ? "Reviews" : "Library"}
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {openId ? (openSummary?.title ?? detail?.review.title ?? "") : "Systematic reviews"}
        </h2>
        {openId && detail ? (
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Review actions" />
              }
            >
              <MoreHorizontal />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={reviews.disabled} onClick={() => setEditing(true)}>
                Edit review…
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={reviews.disabled}
                onClick={() => void deleteReview(detail.review.reviewId, detail.review.title)}
              >
                Delete review
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : !openId ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={reviews.disabled}
            onClick={newReview}
          >
            <Plus />
            New review
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {reviews.error ? (
            <p className="text-sm text-destructive-foreground">{reviews.error}</p>
          ) : null}
          {!openId ? (
            reviews.list === null ? null : reviews.list.reviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">No systematic reviews yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {reviews.list.reviews.map((review) => (
                  <li key={review.reviewId}>
                    <button
                      type="button"
                      className="w-full cursor-pointer rounded-md px-1 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => {
                        setTab("records");
                        reviews.open(review.reviewId);
                      }}
                    >
                      <span className="block truncate text-sm font-medium">{review.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                        {review.searchCount === 1 ? "1 search" : `${review.searchCount} searches`}
                        {` · ${review.prisma.screened} of ${review.prisma.screened + review.prisma.titleAbstract.maybe + review.prisma.titleAbstract.pending} screened`}
                        {` · ${review.prisma.included} included`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : detail ? (
            <>
              {detail.review.question ? (
                <p className="text-sm text-muted-foreground">{detail.review.question}</p>
              ) : null}
              {reviews.conflictVersions > 0 ? (
                <ReviewVersionsLine reviews={reviews} reviewId={detail.review.reviewId} />
              ) : null}
              {reviews.combineReport ? (
                <CombineReportNotice
                  reviews={reviews}
                  reviewId={detail.review.reviewId}
                  report={reviews.combineReport}
                  title={(sourceId) => records.get(sourceId)?.title ?? sourceId}
                  searchName={(searchId) =>
                    detail.review.searches.find((search) => search.searchId === searchId)
                      ?.database ?? searchId
                  }
                />
              ) : null}
              <ToggleGroup
                aria-label="Review section"
                className="w-full *:flex-1"
                value={[tab]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "records" || value === "screening" || value === "prisma")
                    setTab(value);
                }}
              >
                <Toggle value="records">Records</Toggle>
                <Toggle value="screening">Screening</Toggle>
                <Toggle value="prisma">PRISMA</Toggle>
              </ToggleGroup>
              {tab === "records" ? (
                <RecordsTab
                  reviews={reviews}
                  records={records}
                  organization={props.organization}
                  selectedSourceIds={props.selectedSourceIds}
                  onOpenSource={openSource}
                />
              ) : tab === "screening" ? (
                <>
                  <ToggleGroup
                    aria-label="Screening stage"
                    value={[stage]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "title-abstract" || value === "full-text") setStage(value);
                    }}
                  >
                    <Toggle value="title-abstract">Title and abstract</Toggle>
                    <Toggle value="full-text">Full text</Toggle>
                  </ToggleGroup>
                  <SystematicReviewScreening
                    key={`${detail.review.reviewId}:${stage}`}
                    detail={detail}
                    stage={stage}
                    records={records}
                    sourceDetails={props.sourceDetails}
                    loadSource={loadSource}
                    pending={reviews.disabled}
                    onOpenSource={openSource}
                    onRequestName={setNameRequest}
                    onDecide={(sourceId, decision, reason) =>
                      reviews.change(
                        {
                          action: "screen",
                          reviewId: detail.review.reviewId,
                          stage,
                          decisions: [{ sourceId, decision, ...(reason ? { reason } : {}) }],
                        },
                        "Decision was not saved",
                      )
                    }
                    onClear={(sourceId) =>
                      reviews.change(
                        {
                          action: "clear-decision",
                          reviewId: detail.review.reviewId,
                          stage,
                          sourceId,
                        },
                        "Decision was not undone",
                      )
                    }
                    onRetrieval={(sourceId, outcome) =>
                      reviews.change(
                        {
                          action: "record-retrieval",
                          reviewId: detail.review.reviewId,
                          reports: [{ sourceId, outcome }],
                        },
                        "Retrieval was not saved",
                      )
                    }
                  />
                </>
              ) : (
                <PrismaTab reviews={reviews} />
              )}
            </>
          ) : null}
        </div>
      </ScrollArea>
      <SourcesNameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
      {editing && detail ? (
        <EditReviewDialog reviews={reviews} open onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}
