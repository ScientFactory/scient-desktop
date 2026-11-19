import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { msg, useGT, useMessages } from "gt-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { MessageResolver } from "~/i18n/messages";

import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { observeResize } from "../../lib/observeResize";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { LIBRARY_LABELS } from "./libraryLabels";
import { SOURCES_COLUMN } from "./PanelChrome";
import { SourceJournalIcon } from "./SourceJournalIcon";
import { sourceTrustLabel } from "./sourceLifecycleLabels";
import { sourcePinLabel, SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";
import {
  activateSource,
  MetadataReviewIndicator,
  RowStar,
  SourceMenuButton,
  SourcePdfAction,
  SourceProvenance,
  type SourceRowContext,
} from "./SourceRow";
import {
  scientSourceCardRows,
  type ScientSourceSection,
  type SourceCardLabel,
  type SourceCardRow,
} from "./sourceSections";
import { SourcesListEdge, type SourcesViewAnchor } from "./SourcesList";

type SourceRecord = ScientSourcesOverviewResult["records"][number];

const CARD_MIN_WIDTH_REM = 9;
/** Wider than this, a card would only grow taller and emptier; extra width stays as margin. */
const CARD_MAX_WIDTH_REM = 11;
/** Tailwind's `gap-x-3.5`, the space between cards in a row. */
const CARD_GAP_REM = 0.875;
const CARD_ASPECT = 1.3;
const NO_SECTIONS: ReadonlyArray<ScientSourceSection> = [];

function authorsLine(record: SourceRecord, resolve: MessageResolver): string {
  const names = record.creators
    .map((creator) => creator.familyName ?? creator.literalName ?? creator.givenName)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return resolve(msg("Unknown author"));
  return names.length > 3
    ? resolve(msg("{authors}, et al.", { authors: names.slice(0, 3).join(", ") }))
    : names.join(", ");
}

/**
 * The section's name over a row's first card (dimmed when the section began on an earlier row)
 * and over a card that starts one mid-row; a thin line runs on over the rest.
 */
function CardLabel(props: { readonly label: SourceCardLabel | null }) {
  const { label } = props;
  return (
    <div className="flex h-5 items-center gap-1.5 text-xs text-muted-foreground">
      {label && !label.continued ? (
        <h3 className="flex min-w-0 items-center gap-1.5 font-normal">
          <ScientTooltip content={label.section.label}>
            <span className="truncate font-medium text-foreground">{label.section.label}</span>
          </ScientTooltip>
          <span className="shrink-0 tabular-nums">{label.section.count.toLocaleString()}</span>
        </h3>
      ) : label ? (
        <ScientTooltip content={label.section.label}>
          <span aria-hidden className="truncate">
            {label.section.label}
          </span>
        </ScientTooltip>
      ) : null}
      <span className="h-px min-w-3 flex-1 bg-border" />
    </div>
  );
}

function SourceCard(props: { readonly record: SourceRecord; readonly row: SourceRowContext }) {
  const { record, row } = props;
  const gt = useGT();
  const m = useMessages();
  const journal = record.containerTitle?.trim() || null;
  const selected = row.selection.has(record.sourceId);
  const diagnostics = row.diagnosticsBySourceId.get(record.sourceId);
  const onToggleStar = row.onToggleStar;
  return (
    <div
      data-source-card
      className={`group relative flex aspect-[1/1.3] flex-col overflow-hidden rounded-md border bg-card px-3 pt-3 pb-2 shadow-[0_6px_14px_-10px_rgb(0_0_0/0.3)] transition-shadow hover:shadow-[0_10px_22px_-12px_rgb(0_0_0/0.4)] ${selected ? "border-ring ring-2 ring-ring/30" : "border-border"}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        row.onShowMenu(record, { x: event.clientX, y: event.clientY });
      }}
    >
      {/* The folded corner that makes it read as a page. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 right-0 size-0 border-t-[14px] border-l-[14px] border-t-background border-l-border/70"
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex min-h-0 flex-1 cursor-pointer flex-col rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={(event) => activateSource(event, record, row)}
            >
              <span className="flex min-w-0 items-center gap-1.5 pe-3 text-[10px] tracking-wider text-muted-foreground uppercase">
                <SourceJournalIcon
                  environmentId={row.environmentId}
                  root={row.root}
                  record={record}
                />
                <span className="truncate">
                  {journal ?? m(SCIENT_SOURCE_TYPE_LABELS[record.type])}
                </span>
              </span>
              <span className="mt-2.5 line-clamp-5 font-serif text-[15px] leading-snug">
                {record.title ?? gt("Untitled source")}
              </span>
              <span className="mt-auto line-clamp-3 pt-2 text-xs text-muted-foreground">
                {authorsLine(record, m)}
                {record.issuedYear ? ` · ${record.issuedYear}` : ""}
                {sourceTrustLabel(record, m)}
                {record.fromSnapshot ? sourcePinLabel(record, row.listed, m) : null}
              </span>
            </button>
          }
        />
        <TooltipPopup side="top">
          <SourceProvenance record={record} row={row} />
        </TooltipPopup>
      </Tooltip>
      <div className="mt-1.5 flex items-center gap-0.5">
        {row.selection.size > 0 ? (
          <Checkbox
            checked={selected}
            aria-label={gt("Select {title}", { title: record.title ?? gt("Untitled source") })}
            onCheckedChange={() => row.onToggleSelected(record.sourceId)}
          />
        ) : null}
        {record.readingStatus === "unread" ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-sky-500" />
            {m(LIBRARY_LABELS.unread)}
          </span>
        ) : null}
        <span className="flex-1" />
        {diagnostics && diagnostics.length > 0 ? (
          <span className="flex size-6 items-center justify-center">
            <MetadataReviewIndicator
              diagnostics={diagnostics}
              onOpen={() => row.onOpenDetails(record.sourceId)}
            />
          </span>
        ) : null}
        <SourcePdfAction record={record} row={row} size="icon-xs" />
        {record.readingStatus !== undefined ? (
          <RowStar
            title={record.title}
            starred={record.starred === true}
            {...(onToggleStar ? { onToggle: () => onToggleStar(record) } : {})}
          />
        ) : null}
        <SourceMenuButton record={record} row={row} />
      </div>
    </div>
  );
}

/** How many cards fit across `width` pixels of the column, at least one. */
function cardColumns(width: number, rem: number): number {
  return Math.max(
    1,
    Math.floor((width + CARD_GAP_REM * rem) / ((CARD_MIN_WIDTH_REM + CARD_GAP_REM) * rem)),
  );
}

/**
 * Sources as pages in one flow, cut into rows of as many cards as the column holds. Only the
 * rows near the view are mounted; every card keeps the row's actions, journal and year.
 */
export function SourceCards(
  props: {
    readonly records: ReadonlyArray<SourceRecord>;
    readonly row: SourceRowContext;
    /** The sort's headings over the same records; none for Title and Author. */
    readonly sections?: ReadonlyArray<ScientSourceSection> | undefined;
    readonly header?: ReactNode;
    readonly footer?: ReactNode;
  } & SourcesViewAnchor,
) {
  const [layout, setLayout] = useState<{ readonly width: number; readonly rem: number } | null>(
    null,
  );
  const measure = (element: HTMLDivElement | null) => {
    if (!element) return;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const update = (width: number) =>
      setLayout((current) =>
        current && current.width === width && current.rem === rem ? current : { width, rem },
      );
    update(element.getBoundingClientRect().width);
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) update(entry.contentRect.width);
    });
  };
  const columns = layout ? cardColumns(layout.width, layout.rem) : null;
  const sections = props.sections ?? NO_SECTIONS;
  const sectioned = sections.length > 0;
  const rows = columns === null ? [] : scientSourceCardRows(props.records, sections, columns);

  const listRef = useRef<LegendListRef | null>(null);
  const anchored = useRef(false);
  const { anchorSourceId } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls Legend's scroller to the anchor once the measured column count places it in a row
  useEffect(() => {
    if (anchored.current || columns === null || rows.length === 0) return;
    anchored.current = true;
    const index = anchorSourceId
      ? props.records.findIndex((record) => record.sourceId === anchorSourceId)
      : -1;
    if (index >= columns) {
      void listRef.current?.scrollToIndex({ index: Math.floor(index / columns), animated: false });
    }
  }, [anchorSourceId, columns, props.records, rows.length]);

  const cardWidth =
    layout && columns
      ? Math.min(
          (layout.width - (columns - 1) * CARD_GAP_REM * layout.rem) / columns,
          CARD_MAX_WIDTH_REM * layout.rem,
        )
      : CARD_MIN_WIDTH_REM * 16;
  const estimatedRowSize = Math.round(cardWidth * CARD_ASPECT + (sectioned ? 62 : 20));
  const onTopSourceChange = props.onTopSourceChange;
  return (
    <LegendList<SourceCardRow>
      ref={listRef}
      data={rows}
      keyExtractor={(row) => row.key}
      extraData={props.row}
      renderItem={({ item, index }) => (
        <div
          className={`${SOURCES_COLUMN} grid gap-x-3.5 px-3 ${index === 0 ? "pt-3" : ""} ${sectioned ? "pb-6" : "pb-5"}`}
          style={{
            gridTemplateColumns: `repeat(${columns ?? 1}, minmax(0, ${CARD_MAX_WIDTH_REM}rem))`,
          }}
        >
          {item.cards.map((card) => (
            <div key={card.record.sourceId} className="flex min-w-0 flex-col gap-1.5">
              {sectioned ? <CardLabel label={card.label} /> : null}
              <SourceCard record={card.record} row={props.row} />
            </div>
          ))}
        </div>
      )}
      estimatedItemSize={estimatedRowSize}
      drawDistance={estimatedRowSize * 3}
      recycleItems={false}
      {...(onTopSourceChange
        ? {
            onViewableItemsChanged: ({ viewableItems }) => {
              const top = viewableItems[0]?.item.cards[0];
              if (top) onTopSourceChange(top.record.sourceId);
            },
          }
        : {})}
      ListHeaderComponent={
        <>
          <div className={`${SOURCES_COLUMN} px-3`}>
            <div ref={measure} />
          </div>
          {props.header ? <div className={SOURCES_COLUMN}>{props.header}</div> : null}
        </>
      }
      ListFooterComponent={
        props.footer ? (
          <SourcesListEdge edge="footer" ruled={false}>
            {props.footer}
          </SourcesListEdge>
        ) : null
      }
      className="min-h-0 flex-1 overscroll-contain"
    />
  );
}
