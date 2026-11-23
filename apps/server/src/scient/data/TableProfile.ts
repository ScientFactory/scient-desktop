import {
  DATA_TABLE_MAX_COLUMNS,
  dataTableCellText,
  dataTablePageRows,
  type DataTableColumn,
  type DataTablePage,
  type DataTableTotals,
} from "@scientfactory/compute";
import type { DataProfile, DataProfileEvent } from "@t3tools/contracts";

import type { TableSource } from "./TableView.ts";

const PROFILE_MAX_ROWS = 2_048;
const PROFILE_MAX_CELLS = 65_536;
const TRACKED_VALUES = 16_384;
const INTEGER = /^[-+]?\d+$/;

const profileRowLimit = (columnCount: number) =>
  Math.min(PROFILE_MAX_ROWS, Math.floor(PROFILE_MAX_CELLS / Math.max(1, columnCount)));

export interface WholeColumnStatistics {
  readonly missing?: number;
  readonly distinct?: number;
  readonly range?: { readonly min: string; readonly max: string };
}

interface NumericValue {
  readonly text: string;
  readonly value: bigint | number;
}

function numericValue(type: "integer" | "number", text: string): NumericValue | null {
  const trimmed = text.trim();
  if (!trimmed || (type === "integer" && !INTEGER.test(trimmed))) return null;
  const value = type === "integer" && trimmed.length > 15 ? BigInt(trimmed) : Number(trimmed);
  return typeof value === "number" && Number.isNaN(value) ? null : { text, value };
}

class ColumnProfile {
  private readonly counts = new Map<string, number>();
  private missing = 0;
  private nanCount = 0;
  private clipped = false;
  private capped = false;
  private numeric: "integer" | "number" | null;
  private min: NumericValue | undefined;
  private max: NumericValue | undefined;
  private readonly column: DataTableColumn;

  constructor(column: DataTableColumn) {
    this.column = column;
    this.numeric = column.type === "number" || column.type === "integer" ? column.type : null;
  }

  add(value: string | null | undefined, valueLimit: number, countNaN: boolean) {
    if (value == null) {
      this.missing++;
      return;
    }
    if (countNaN && this.column.type === "number" && value === "NaN") {
      this.nanCount++;
      return;
    }
    const text = dataTableCellText(value);
    this.clipped ||= text !== value;
    const count = this.counts.get(text);
    if (count !== undefined || this.counts.size < valueLimit)
      this.counts.set(text, (count ?? 0) + 1);
    else this.capped = true;

    if (this.numeric !== null) {
      const number = this.clipped ? null : numericValue(this.numeric, value);
      if (number === null) {
        this.numeric = null;
      } else {
        if (this.min === undefined || number.value < this.min.value) this.min = number;
        if (this.max === undefined || number.value > this.max.value) this.max = number;
      }
    }
  }

  finish(
    columnIndex: number,
    rowsSampled: number,
    rowCount: number | null,
    whole: WholeColumnStatistics | undefined,
    preclipped: boolean,
  ) {
    const clipped = this.clipped || preclipped;
    const range =
      whole?.range ??
      (!clipped && this.numeric !== null && this.min && this.max
        ? { min: this.min.text, max: this.max.text }
        : null);
    const top =
      range === null
        ? [...this.counts]
            .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0))
            .slice(0, 3)
            .map(([value, count]) => ({ value, count }))
        : [];
    const missing = whole?.missing ?? this.missing;
    const n = whole?.missing !== undefined ? rowCount : rowsSampled;
    return {
      columnIndex,
      column: this.column,
      missing,
      ...(this.nanCount > 0 ? { nanCount: this.nanCount } : {}),
      missingShare: n ? missing / n : null,
      missingFromFooter: whole?.missing !== undefined,
      distinct: whole?.distinct ?? this.counts.size + Number(this.nanCount > 0),
      distinctFromFooter: whole?.distinct !== undefined,
      distinctLowerBound: whole?.distinct === undefined && (clipped || this.capped),
      valuesClipped: clipped,
      topTracked: this.capped,
      range,
      rangeFromFooter: whole?.range !== undefined,
      top,
    };
  }
}

interface ProfileDisplay {
  readonly countNaN: boolean;
  readonly clippedColumns: ReadonlyArray<boolean>;
}

class TableProfile {
  private readonly columns: ReadonlyArray<ColumnProfile>;
  private readonly valueLimit: number;
  private readonly columnCount: number;
  private readonly rowCount: number | null;
  private readonly display: ProfileDisplay | undefined;
  rowsProfiled = 0;

  constructor(
    columns: ReadonlyArray<DataTableColumn>,
    columnCount: number,
    rowCount: number | null,
    display?: ProfileDisplay,
  ) {
    this.columnCount = columnCount;
    this.rowCount = rowCount;
    this.display = display;
    this.columns = columns
      .slice(0, DATA_TABLE_MAX_COLUMNS)
      .map((column) => new ColumnProfile(column));
    this.valueLimit = Math.floor(TRACKED_VALUES / Math.max(1, this.columns.length));
  }

  addRow(row: ReadonlyArray<string | null>): void {
    for (const [index, column] of this.columns.entries()) {
      column.add(row[index], this.valueLimit, this.display?.countNaN ?? false);
    }
    this.rowsProfiled++;
  }

  add(rows: ReadonlyArray<ReadonlyArray<string | null>>): void {
    for (const row of rows) this.addRow(row);
  }

  finish(whole?: ReadonlyArray<WholeColumnStatistics | undefined>): DataProfile {
    const rowsProfiled = this.rowsProfiled;
    return {
      scope: this.rowCount === rowsProfiled ? "all" : "sample",
      rowsProfiled,
      rowCount: this.rowCount,
      columnCount: this.columnCount,
      columns: this.columns.map((column, index) =>
        column.finish(
          index,
          rowsProfiled,
          this.rowCount,
          whole?.[index],
          this.display?.clippedColumns[index] ?? false,
        ),
      ),
    };
  }
}

export function wholeTableProfile(
  columns: ReadonlyArray<DataTableColumn>,
  columnCount: number,
  totals: DataTableTotals,
  footer?: ReadonlyArray<WholeColumnStatistics | undefined>,
): DataProfile {
  const { rowCount } = totals;
  return {
    scope: "all",
    rowCount,
    rowsProfiled: rowCount,
    columnCount,
    columns: totals.columns.map((statistics, columnIndex) => {
      const metadata = footer?.[columnIndex];
      const missing = metadata?.missing ?? statistics.missing;
      return {
        ...statistics,
        columnIndex,
        column: columns[columnIndex]!,
        missing,
        missingShare: rowCount === 0 ? null : missing / rowCount,
        missingFromFooter: metadata?.missing !== undefined,
        distinct:
          metadata?.distinct ??
          (statistics.distinctApproximate
            ? Math.min(statistics.distinct, rowCount - missing)
            : statistics.distinct),
        distinctFromFooter: metadata?.distinct !== undefined,
        distinctApproximate:
          metadata?.distinct === undefined && (statistics.distinctApproximate ?? false),
        distinctLowerBound: statistics.distinctLowerBound ?? false,
        range: metadata?.range ?? statistics.range,
        rangeFromFooter: metadata?.range !== undefined,
        topTracked: statistics.topTracked ?? false,
        valuesClipped: statistics.valuesClipped ?? false,
      };
    }),
  };
}

export function profileTablePage(page: DataTablePage, display?: ProfileDisplay): DataProfile {
  if (page.totals?.rowCount === page.rowCount && page.totals.columns.length === page.columns.length)
    return wholeTableProfile(page.columns, page.columnCount, page.totals);
  const profile = new TableProfile(
    page.columns,
    page.columnCount,
    page.truncated ? null : page.rowCount,
    display,
  );
  profile.add(page.rows.map((row) => row.cells));
  return profile.finish();
}

export async function profileTableSource(
  source: TableSource,
  signal: AbortSignal,
  onProgress: (event: Extract<DataProfileEvent, { _tag: "Progress" }>) => void,
  whole:
    | ReadonlyArray<WholeColumnStatistics | undefined>
    | undefined = source.profileStatistics?.(),
): Promise<DataProfile> {
  const width = Math.min(source.columns.length, DATA_TABLE_MAX_COLUMNS);
  const rowCount = source.truncated ? null : source.rowCount;
  const profile = new TableProfile(source.columns, source.columns.length, rowCount);
  const target =
    source.scanProfileRows === undefined
      ? Math.min(source.rowCount, profileRowLimit(width))
      : source.rowCount;
  const progress = () =>
    onProgress({ _tag: "Progress", rowsProfiled: profile.rowsProfiled, rowCount, target });
  progress();
  if (source.scanProfileRows !== undefined) {
    await source.scanProfileRows(width, signal, (row) => profile.addRow(row), progress);
  } else {
    const batchSize = dataTablePageRows(width);
    for (let offset = 0; offset < target; offset += batchSize) {
      signal.throwIfAborted();
      const count = Math.min(target - offset, batchSize);
      const rows = await source.readRows(
        Array.from({ length: count }, (_, index) => offset + index),
        width,
        signal,
        true,
      );
      profile.add(rows);
      progress();
    }
  }
  return profile.finish(whole);
}
