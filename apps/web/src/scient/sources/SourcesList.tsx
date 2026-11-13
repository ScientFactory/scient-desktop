import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import type { ReactNode } from "react";

import { ScrollArea } from "../../components/ui/scroll-area";
import { SourceRow, type SourceRowContext } from "./SourceRow";

type SourceRecord = ScientSourcesOverviewResult["records"][number];

/**
 * The shortest row (one-line title and details, divider included), the same with or without the
 * star slot. Real rows are taller, so the first render never leaves a gap before rows measure.
 */
export const SOURCE_ROW_ESTIMATED_SIZE = 63;

/**
 * A Library holds thousands of sources; only the rows near the view are mounted. Each row draws
 * its own divider because mounted rows are positioned, not stacked, so `divide-y` cannot.
 */
export function SourcesList(props: {
  readonly records: ReadonlyArray<SourceRecord>;
  readonly row: SourceRowContext;
  readonly virtualized: boolean;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
}) {
  // The project backend keeps the shared overlay scrollbar and every row mounted; only a
  // Library scope virtualizes. Project users must see no change before the flip.
  if (!props.virtualized) {
    return (
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y divide-border">
          {props.header}
          {props.records.map((record) => (
            <SourceRow key={record.sourceId} record={record} row={props.row} />
          ))}
          {props.footer}
        </div>
      </ScrollArea>
    );
  }
  const divided = props.records.length > 0;
  return (
    <LegendList<SourceRecord>
      data={props.records}
      keyExtractor={(record) => record.sourceId}
      extraData={props.row}
      renderItem={({ item: record, index }) => (
        <div className={index > 0 ? "border-t border-border" : undefined}>
          <SourceRow record={record} row={props.row} />
        </div>
      )}
      estimatedItemSize={SOURCE_ROW_ESTIMATED_SIZE}
      drawDistance={SOURCE_ROW_ESTIMATED_SIZE * 8}
      recycleItems={false}
      ListHeaderComponent={
        props.header ? (
          <div className={divided ? "[&>*]:border-b [&>*]:border-border" : undefined}>
            {props.header}
          </div>
        ) : null
      }
      ListFooterComponent={
        props.footer ? (
          <div className={divided ? "[&>*]:border-t [&>*]:border-border" : undefined}>
            {props.footer}
          </div>
        ) : null
      }
      className="min-h-0 flex-1 overscroll-contain"
    />
  );
}
