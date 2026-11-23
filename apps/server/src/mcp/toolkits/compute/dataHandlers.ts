import * as Effect from "effect/Effect";

import { agentScope, computeFailed, toolError } from "./agentComputeScope.ts";

export const profileScientData = Effect.fn("ScientDataTools.profile")(function* (input: {
  readonly path: string;
  readonly sheet?: number | undefined;
  readonly columns?: ReadonlyArray<string> | undefined;
}) {
  const { gateway, cwd } = yield* agentScope();
  const profile = yield* gateway
    .profileDataset({
      cwd,
      path: input.path,
      ...(input.sheet === undefined ? {} : { sheet: input.sheet }),
    })
    .pipe(Effect.mapError(computeFailed));
  if (input.columns?.length) {
    const names = new Set(input.columns);
    const columns = profile.columns.filter(({ column }) => names.has(column.name));
    if (columns.length < names.size)
      return yield* toolError(
        "compute-failed",
        "One or more requested columns are unavailable in the profile.",
      );
    return { ...profile, columns: columns.slice(0, 32), cappedColumns: columns.length > 32 };
  }
  const columns = profile.columns.slice(0, 32);
  return { ...profile, columns, cappedColumns: columns.length < profile.columnCount };
});

export const previewScientDataView = Effect.fn("ScientDataTools.previewView")(function* (input: {
  readonly path: string;
  readonly limit?: number | undefined;
}) {
  const { gateway, cwd } = yield* agentScope();
  const limit = input.limit ?? 10;
  const page = yield* gateway
    .previewDataView({
      cwd,
      path: input.path,
      query: { offset: 0, limit: limit + 1, sort: null, search: "" },
    })
    .pipe(Effect.mapError(computeFailed));
  const columns = page.columns.slice(0, 20);
  const rows = page.rows.slice(0, limit).map((row) => ({
    ...row,
    cells: row.cells.slice(0, columns.length),
  }));
  return {
    columns,
    rows,
    rowCount: page.rowCount,
    columnCount: page.columnCount,
    cappedRows: rows.length < page.rowCount,
    cappedColumns: columns.length < page.columnCount,
  };
});

export const materializeScientDataView = Effect.fn("ScientDataTools.materializeView")(
  function* (input: { readonly path: string; readonly destination: string }) {
    const { gateway, cwd } = yield* agentScope();
    return yield* gateway
      .materializeDataView({ cwd, ...input })
      .pipe(Effect.mapError(computeFailed));
  },
);
