import {
  DATA_TABLE_MAX_COLUMNS,
  dataTablePageRows,
  type DataTableColumn,
  type DataTablePage,
  type DataTableQuery,
} from "@scientfactory/compute";

/** Comparable values for one column: numbers (NaN when missing) or text (null when missing). */
export type SortKeys = Float64Array | ReadonlyArray<string | null>;

/**
 * A table the viewer can page through without holding it whole. Rows are addressed by their
 * zero-based position in the source; cells are display text, null for a missing value.
 */
export interface TableSource {
  readonly columns: ReadonlyArray<DataTableColumn>;
  readonly rowCount: number;
  readonly truncated: boolean;
  /** Cells of these rows, in the order given, for the first `columnLimit` columns. */
  readonly readRows: (
    rows: ReadonlyArray<number>,
    columnLimit: number,
    signal: AbortSignal,
  ) => Promise<Array<Array<string | null>>>;
  readonly sortKeys: (column: number, signal: AbortSignal) => Promise<SortKeys>;
  /** Rows, ascending, with a cell whose text contains `needle` (already lowercase). */
  readonly search: (needle: string, signal: AbortSignal) => Promise<Uint32Array>;
}

interface Computation {
  readonly promise: Promise<Uint32Array>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
}

/**
 * Sort and search results for one source, kept while the source stays open. A computation is
 * shared by every request that needs it and stops only when all of them have gone.
 */
export class TableViewCache {
  private readonly entries = new Map<string, Computation>();
  readonly source: TableSource;

  constructor(source: TableSource) {
    this.source = source;
  }

  private join(
    key: string,
    compute: (signal: AbortSignal) => Promise<Uint32Array>,
    signal: AbortSignal,
  ): Promise<Uint32Array> {
    let entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    else {
      const controller = new AbortController();
      const created: Computation = {
        promise: compute(controller.signal),
        controller,
        waiters: 0,
        settled: false,
      };
      created.promise.then(
        () => (created.settled = true),
        () => {
          created.settled = true;
          if (this.entries.get(key) === created) this.entries.delete(key);
        },
      );
      entry = created;
    }
    this.entries.set(key, entry);
    while (this.entries.size > 6) this.entries.delete(this.entries.keys().next().value!);
    const joined = entry;
    joined.waiters++;
    return new Promise((resolve, reject) => {
      const leave = () => {
        signal.removeEventListener("abort", abandon);
        joined.waiters--;
      };
      const abandon = () => {
        leave();
        if (joined.waiters === 0 && !joined.settled) {
          joined.controller.abort(signal.reason);
          if (this.entries.get(key) === joined) this.entries.delete(key);
        }
        reject(signal.reason);
      };
      if (signal.aborted) return abandon();
      signal.addEventListener("abort", abandon, { once: true });
      joined.promise.then(
        (rows) => {
          leave();
          resolve(rows);
        },
        (cause) => {
          leave();
          reject(cause);
        },
      );
    });
  }

  /** Every row in view order; missing values come last in either direction. */
  sorted(column: number, descending: boolean, signal: AbortSignal): Promise<Uint32Array> {
    return this.join(
      `sort:${column}:${descending}`,
      async (shared) => sortRows(await this.source.sortKeys(column, shared), descending),
      signal,
    );
  }

  matches(needle: string, signal: AbortSignal): Promise<Uint32Array> {
    return this.join(`search:${needle}`, (shared) => this.source.search(needle, shared), signal);
  }
}

function sortRows(keys: SortKeys, descending: boolean): Uint32Array {
  const order = new Uint32Array(keys.length);
  let present = 0;
  let missing = keys.length;
  for (let row = 0; row < keys.length; row++) {
    const key = keys[row];
    if (key === null || (typeof key === "number" && Number.isNaN(key))) order[--missing] = row;
    else order[present++] = row;
  }
  // Missing rows were filled from the end; keep them in source order.
  order.subarray(present).reverse();
  const direction = descending ? -1 : 1;
  const values = order.subarray(0, present);
  if (keys instanceof Float64Array)
    values.sort((a, b) => direction * (keys[a]! - keys[b]!) || a - b);
  else {
    const text = keys as ReadonlyArray<string>;
    values.sort((a, b) =>
      text[a]! < text[b]! ? -direction : text[a]! > text[b]! ? direction : a - b,
    );
  }
  return order;
}

/** The rows of the view at [offset, offset + limit). */
function viewRows(
  rowCount: number,
  sorted: Uint32Array | null,
  matches: Uint32Array | null,
  offset: number,
  limit: number,
): { readonly rows: number[]; readonly matchCount: number } {
  if (sorted === null) {
    const count = matches ? matches.length : rowCount;
    const end = Math.min(count, offset + limit);
    const rows: number[] = [];
    for (let position = offset; position < end; position++)
      rows.push(matches ? matches[position]! : position);
    return { rows, matchCount: count };
  }
  let order = sorted;
  if (matches) {
    const keep = new Uint8Array(rowCount);
    for (const row of matches) keep[row] = 1;
    order = order.filter((row) => keep[row] === 1);
  }
  return {
    rows: Array.from(order.subarray(offset, Math.min(order.length, offset + limit))),
    matchCount: order.length,
  };
}

export async function readTablePage(
  cache: TableViewCache,
  query: DataTableQuery,
  signal: AbortSignal,
  rowLabel: (row: number) => string = (row) => String(row + 1),
): Promise<DataTablePage> {
  const { source } = cache;
  const columns = source.columns.slice(0, DATA_TABLE_MAX_COLUMNS);
  const needle = query.search.trim().toLowerCase();
  const sortColumn =
    query.sort !== null && query.sort.column < columns.length ? query.sort.column : null;
  const [sorted, matches] = await Promise.all([
    sortColumn === null ? null : cache.sorted(sortColumn, query.sort!.descending, signal),
    needle ? cache.matches(needle, signal) : null,
  ]);
  const { rows, matchCount } = viewRows(
    source.rowCount,
    sorted,
    matches,
    query.offset,
    Math.min(query.limit, dataTablePageRows(columns.length)),
  );
  const cells = rows.length ? await source.readRows(rows, columns.length, signal) : [];
  return {
    columns,
    columnCount: source.columns.length,
    rowCount: source.rowCount,
    matchCount,
    truncated: source.truncated,
    offset: query.offset,
    rows: rows.map((row, index) => ({ label: rowLabel(row), cells: cells[index]! })),
  };
}
