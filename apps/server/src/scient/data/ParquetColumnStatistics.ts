import type { DataTableColumn } from "@scientfactory/compute";
import type { FileMetaData, SchemaTree, Statistics } from "hyparquet";

import type { WholeColumnStatistics } from "./TableProfile.ts";

function numericBounds(statistics: Statistics, node: SchemaTree) {
  const element = node.element;
  const legacySigned =
    (element.type === "INT32" ||
      element.type === "INT64" ||
      element.type === "FLOAT" ||
      element.type === "DOUBLE") &&
    !element.converted_type?.startsWith("UINT_") &&
    !(element.logical_type?.type === "INTEGER" && !element.logical_type.isSigned);
  const min =
    statistics.is_min_value_exact === true
      ? statistics.min_value
      : statistics.is_min_value_exact === undefined && legacySigned
        ? statistics.min
        : undefined;
  const max =
    statistics.is_max_value_exact === true
      ? statistics.max_value
      : statistics.is_max_value_exact === undefined && legacySigned
        ? statistics.max
        : undefined;
  const numeric = (value: unknown): value is number | bigint =>
    typeof value === "bigint" || (typeof value === "number" && !Number.isNaN(value));
  return numeric(min) && numeric(max) && min <= max ? { min, max } : undefined;
}

export function parquetColumnStatistics(
  metadata: FileMetaData,
  nodes: ReadonlyArray<SchemaTree>,
  columns: ReadonlyArray<DataTableColumn>,
): ReadonlyArray<WholeColumnStatistics | undefined> {
  const leaf = new Map<string, number>();
  for (const [index, chunk] of (metadata.row_groups[0]?.columns ?? []).entries()) {
    const path = chunk.meta_data?.path_in_schema;
    if (path?.length === 1) leaf.set(path[0]!, index);
  }
  return columns.map((column, position) => {
    const node = nodes[position]!;
    const index = leaf.get(column.name);
    if (
      index === undefined ||
      node.children.length !== 0 ||
      node.element.repetition_type === "REPEATED"
    )
      return undefined;

    let missing = 0;
    let hasNullCounts = true;
    let allRanges =
      column.type === "integer" || (column.type === "number" && column.label !== "decimal");
    let min: number | bigint | undefined;
    let max: number | bigint | undefined;
    for (const group of metadata.row_groups) {
      const statistics = group.columns[index]?.meta_data?.statistics;
      const rows = Number(group.num_rows);
      const nulls =
        statistics?.null_count === undefined ? undefined : Number(statistics.null_count);
      if (nulls !== undefined && nulls >= 0 && nulls <= rows) missing += nulls;
      else hasNullCounts = false;
      if (rows === 0 || nulls === rows || !allRanges) continue;
      const bounds = statistics ? numericBounds(statistics, node) : undefined;
      if (!bounds) {
        allRanges = false;
        continue;
      }
      if (min === undefined || bounds.min < min) min = bounds.min;
      if (max === undefined || bounds.max > max) max = bounds.max;
    }
    const recordedDistinct =
      metadata.row_groups.length === 1
        ? metadata.row_groups[0]?.columns[index]?.meta_data?.statistics?.distinct_count
        : undefined;
    const distinct = recordedDistinct === undefined ? undefined : Number(recordedDistinct);
    return {
      ...(hasNullCounts ? { missing } : {}),
      ...(distinct !== undefined &&
      Number.isSafeInteger(distinct) &&
      distinct >= 0 &&
      distinct <= Number(metadata.num_rows)
        ? { distinct }
        : {}),
      ...(allRanges && min !== undefined && max !== undefined
        ? { range: { min: String(min), max: String(max) } }
        : {}),
    };
  });
}
