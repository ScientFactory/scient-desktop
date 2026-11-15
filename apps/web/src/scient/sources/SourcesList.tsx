import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import type { ReactNode } from "react";

import { ScrollArea } from "../../components/ui/scroll-area";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { SOURCES_COLUMN } from "./PanelChrome";
import type { ScientSourceSection } from "./sourceSections";
import { SourceRow, type SourceRowContext } from "./SourceRow";
import "./sources-list.css";

type SourceRecord = ScientSourcesOverviewResult["records"][number];

const NO_SECTIONS: ReadonlyArray<ScientSourceSection> = [];

/**
 * The shortest row (one-line title and details, divider included), the same with or without the
 * star slot. Real rows are taller, so the first render never leaves a gap before rows measure.
 */
export const SOURCE_ROW_ESTIMATED_SIZE = 63;

/** What both views share besides their records: where to start and where the top now is. */
export interface SourcesViewAnchor {
  /** Scrolled to when the view mounts, as after switching between list and cards. */
  readonly anchorSourceId?: string | null | undefined;
  readonly onTopSourceChange?: ((sourceId: string) => void) | undefined;
}

interface SourcesListItem {
  readonly record: SourceRecord;
  /** The section this source opens; a section starts after a gap, not a line. */
  readonly opens: ScientSourceSection | null;
  readonly divided: boolean;
}

/** A section's name and count with a thin line running on, as over the cards. */
function SourcesSectionHeading(props: { readonly section: ScientSourceSection }) {
  return (
    <h3
      className={`mx-3 flex items-center gap-1.5 pb-1 text-xs font-normal text-muted-foreground ${props.section.start === 0 ? "pt-3" : "pt-6"}`}
    >
      <ScientTooltip content={props.section.label}>
        <span className="truncate font-medium text-foreground">{props.section.label}</span>
      </ScientTooltip>
      <span className="shrink-0 tabular-nums">{props.section.count.toLocaleString()}</span>
      <span aria-hidden className="h-px min-w-3 flex-1 bg-border" />
    </h3>
  );
}

/**
 * Lines divide the rows; a hovered or focused row becomes a rounded tile and the lines on both
 * sides of it give way (`sources-list.css`), without React state.
 */
function SourcesListRow(props: { readonly item: SourcesListItem; readonly row: SourceRowContext }) {
  const { item } = props;
  return (
    <div data-sources-item className={`relative ${SOURCES_COLUMN}`}>
      {item.opens ? <SourcesSectionHeading section={item.opens} /> : null}
      <div
        className={`sources-row-tile mx-3 border-t ${item.divided ? "border-border" : "border-transparent"}`}
      >
        <SourceRow record={item.record} row={props.row} />
      </div>
    </div>
  );
}

/** A header or footer inside the list's column, ruled off from the rows. */
export function SourcesListEdge(props: {
  readonly edge: "header" | "footer";
  readonly ruled: boolean;
  readonly children: ReactNode;
}) {
  const rule = props.edge === "header" ? "[&>*]:border-b" : "[&>*]:border-t";
  return (
    <div
      className={`${SOURCES_COLUMN} [&>*]:mx-3 ${props.ruled ? `${rule} [&>*]:border-border` : ""}`}
    >
      {props.children}
    </div>
  );
}

function sourcesListItems(
  records: ReadonlyArray<SourceRecord>,
  sections: ReadonlyArray<ScientSourceSection>,
): ReadonlyArray<SourcesListItem> {
  const opening = new Map(sections.map((section) => [section.start, section]));
  return records.map((record, index) => {
    const opens = opening.get(index) ?? null;
    return { record, opens, divided: index > 0 && opens === null };
  });
}

/**
 * A Library holds thousands of sources; only the rows near the view are mounted. Each row draws
 * its own divider because mounted rows are positioned, not stacked, so `divide-y` cannot.
 */
export function SourcesList(
  props: {
    readonly records: ReadonlyArray<SourceRecord>;
    readonly row: SourceRowContext;
    /** The sort's headings over the same records; none for Title and Author. */
    readonly sections?: ReadonlyArray<ScientSourceSection> | undefined;
    readonly virtualized: boolean;
    readonly header?: ReactNode;
    readonly footer?: ReactNode;
  } & SourcesViewAnchor,
) {
  const sections = props.sections ?? NO_SECTIONS;
  const items = sourcesListItems(props.records, sections);
  // The project backend keeps the shared overlay scrollbar and every row mounted; only a
  // Library scope virtualizes. Project users must see no change before the flip.
  if (!props.virtualized) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div>
          {props.header ? (
            <SourcesListEdge edge="header" ruled>
              {props.header}
            </SourcesListEdge>
          ) : null}
          {items.map((item) => (
            <SourcesListRow key={item.record.sourceId} item={item} row={props.row} />
          ))}
          {props.footer ? (
            <SourcesListEdge edge="footer" ruled>
              {props.footer}
            </SourcesListEdge>
          ) : null}
        </div>
      </ScrollArea>
    );
  }
  const divided = items.length > 0;
  const anchorIndex = props.anchorSourceId
    ? items.findIndex((item) => item.record.sourceId === props.anchorSourceId)
    : -1;
  const onTopSourceChange = props.onTopSourceChange;
  return (
    <LegendList<SourcesListItem>
      data={items}
      keyExtractor={(item) => item.record.sourceId}
      // Each item carries its section, so a new heading re-renders the row; the shared row state goes here.
      extraData={props.row}
      renderItem={({ item }) => <SourcesListRow item={item} row={props.row} />}
      estimatedItemSize={SOURCE_ROW_ESTIMATED_SIZE}
      drawDistance={SOURCE_ROW_ESTIMATED_SIZE * 8}
      recycleItems={false}
      {...(anchorIndex > 0 ? { initialScrollIndex: anchorIndex } : {})}
      {...(onTopSourceChange
        ? {
            onViewableItemsChanged: ({ viewableItems }) => {
              const top = viewableItems[0]?.item;
              if (top) onTopSourceChange(top.record.sourceId);
            },
          }
        : {})}
      ListHeaderComponent={
        props.header ? (
          <SourcesListEdge edge="header" ruled={divided}>
            {props.header}
          </SourcesListEdge>
        ) : null
      }
      ListFooterComponent={
        props.footer ? (
          <SourcesListEdge edge="footer" ruled={divided}>
            {props.footer}
          </SourcesListEdge>
        ) : null
      }
      className="sources-virtual-list min-h-0 flex-1 overscroll-contain"
    />
  );
}
