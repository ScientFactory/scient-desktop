import {
  dataTableCellText,
  EnvironmentFilePath,
  type ComputeResultsCompareResult,
  type ComputeResultsPreviewResult,
  type DataTableQuery,
  type DataTableColumn,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { lazy, Suspense, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import { AttachmentImage } from "~/components/media/AttachmentImage";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { DataGrid } from "../dataTable/DataGrid";
import { isNumericType } from "../dataTable/dataGridModel";

const PdfFigure = lazy(() => import("./ResultPdfFigure"));

type RevisionPair = Pick<ComputeResultsCompareResult, "from" | "to">;
type OutputDiff = ComputeResultsCompareResult["outputs"][number];

export function ResultComparisonOutputs(
  props: RevisionPair & {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly outputs: ReadonlyArray<OutputDiff>;
    readonly kind: "figure" | "table";
  },
) {
  const gt = useGT();
  const [chosen, setChosen] = useState<string | null>(null);
  const available = props.outputs.filter((output) => output.kind === props.kind);
  const output = available.find((entry) => entry.name === chosen) ?? available[0];
  if (output === undefined) return null;
  const label = props.kind === "figure" ? gt("Figure") : gt("CSV table");
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{label}</h3>
        {available.length > 1 ? (
          <Select
            items={available.map(({ name }) => ({ value: name, label: name }))}
            value={output.name}
            onValueChange={setChosen}
          >
            <SelectTrigger size="sm" width="content" aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {available.map(({ name }) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <bdi className="min-w-0 break-all text-muted-foreground">{output.name}</bdi>
        )}
        {output.change !== "same" ? (
          <span className="text-xs text-muted-foreground">
            {output.change === "changed"
              ? gt("File differs")
              : output.change === "added"
                ? gt("Added")
                : gt("Removed")}
          </span>
        ) : null}
      </div>
      <OutputPair {...props} output={output} />
    </section>
  );
}

function OutputPair(
  props: RevisionPair & {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly output: OutputDiff;
  },
) {
  const gt = useGT();
  const query = (revision: string) =>
    computeEnvironment.resultsPreview({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, revision, output: props.output.name },
    });
  const earlier = useEnvironmentQuery(
    props.output.change === "added" ? null : query(props.from.revision),
  );
  const later = useEnvironmentQuery(
    props.output.change === "removed" ? null : query(props.to.revision),
  );
  const left = earlier.data?._tag === "table" ? earlier.data : null;
  const right = later.data?._tag === "table" ? later.data : null;
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 @min-[720px]:grid-cols-2">
      {[
        { label: gt("From"), view: earlier, table: left, other: right, side: "earlier" },
        { label: gt("To"), view: later, table: right, other: left, side: "later" },
      ].map(({ label, view, table, other, side }) => (
        <div key={side} className="flex min-w-0 flex-col gap-1">
          <h4 className="text-xs text-muted-foreground">{label}</h4>
          {table === null ? (
            <OutputPreview
              data={view.data}
              error={view.error}
              pending={view.isPending}
              environmentId={props.environmentId}
              name={props.output.name}
            />
          ) : (
            <div className="grid h-56 w-full min-w-0 grid-cols-1 overflow-hidden rounded-lg border border-border">
              <ComparisonTable
                label={label}
                rows={table.rows}
                columns={table.columns}
                other={other?.rows ?? null}
                compareCells={
                  other !== null ||
                  props.output.change === "added" ||
                  props.output.change === "removed"
                }
                revision={`${props.from.revision}/${props.to.revision}/${props.output.name}/${side}`}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function OutputPreview(props: {
  readonly data: ComputeResultsPreviewResult | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly environmentId: EnvironmentId;
  readonly name: string;
}) {
  if (props.pending)
    return (
      <span role="status">
        <T>Loading preview…</T>
      </span>
    );
  if (props.error !== null) return <span role="alert">{props.error}</span>;
  if (props.data?._tag === "figure") return <FigurePreview {...props} figure={props.data} />;
  return (
    <p className="text-muted-foreground">
      {props.data?._tag === "unavailable" && props.data.reason === "pruned" ? (
        <T>This file has aged out of local history.</T>
      ) : props.data?._tag === "unavailable" && props.data.reason === "table-limit" ? (
        <T>This CSV is outside the table preview limits.</T>
      ) : (
        <T>No saved file</T>
      )}
    </p>
  );
}

function FigurePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly figure: Extract<ComputeResultsPreviewResult, { _tag: "figure" }>;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "environment-file",
    path: EnvironmentFilePath.make(props.figure.path),
    access: "exact",
  });
  if (asset._tag === "Loading")
    return (
      <span role="status">
        <T>Loading preview…</T>
      </span>
    );
  if (asset._tag === "Failure")
    return (
      <span role="alert">
        <T>The figure could not be opened.</T>
      </span>
    );
  if (props.figure.mediaType === "application/pdf")
    return (
      <Suspense
        fallback={
          <span role="status">
            <T>Loading PDF…</T>
          </span>
        }
      >
        <PdfFigure url={asset.url} name={props.name} />
      </Suspense>
    );
  return (
    <>
      <div className="flex min-w-0 flex-col items-center gap-1 rounded-lg bg-muted/40 p-2">
        <AttachmentImage
          key={asset.url}
          src={asset.url}
          name={props.name}
          mimeType={props.figure.mediaType}
          loading="lazy"
          alt={props.name}
          className="h-auto max-h-72 w-full object-contain"
        />
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setExpanded(true)}
          aria-label={gt("Enlarge {name}", { name: props.name })}
        >
          <T>Enlarge</T>
        </Button>
      </div>
      {expanded ? (
        <ExpandedImageDialog
          onClose={() => setExpanded(false)}
          preview={{
            images: [{ src: asset.url, name: props.name, mimeType: props.figure.mediaType }],
            index: 0,
          }}
        />
      ) : null}
    </>
  );
}

function ComparisonTable(props: {
  readonly label: string;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly columns?: ReadonlyArray<DataTableColumn> | undefined;
  readonly other: ReadonlyArray<ReadonlyArray<string>> | null;
  readonly revision: string;
  readonly compareCells: boolean;
}) {
  const columns =
    props.columns ??
    (props.rows[0] ?? []).map((name) => ({ name, type: "text" as const, label: "" }));
  const loadPage = async ({ offset, limit, search, sort }: DataTableQuery) => {
    const needle = search.toLocaleLowerCase();
    const data = props.rows
      .slice(1)
      .map((cells, index) => ({ label: String(index + 1), cells }))
      .filter(
        ({ cells }) =>
          needle.length === 0 || cells.some((cell) => cell.toLocaleLowerCase().includes(needle)),
      );
    if (sort !== null) {
      const type = columns[sort.column]?.type ?? "text";
      const direction = sort.descending ? -1 : 1;
      data.sort((a, b) => {
        const left = a.cells[sort.column] ?? "";
        const right = b.cells[sort.column] ?? "";
        if (!isNumericType(type)) return direction * left.localeCompare(right);
        const first = left.trim() === "" ? Number.NaN : Number(left);
        const second = right.trim() === "" ? Number.NaN : Number(right);
        if (Number.isNaN(first) || Number.isNaN(second))
          return Number(Number.isNaN(first)) - Number(Number.isNaN(second));
        return direction * (first - second);
      });
    }
    return {
      columns,
      columnCount: columns.length,
      rowCount: props.rows.length - 1,
      matchCount: data.length,
      offset,
      truncated: false,
      rows: data
        .slice(offset, offset + limit)
        .map(({ label, cells }) => ({ label, cells: cells.map(dataTableCellText) })),
    };
  };
  return (
    <DataGrid
      key={props.revision}
      label={props.label}
      revision={props.revision}
      loadPage={loadPage}
      isCellChanged={(label, column) =>
        props.compareCells &&
        props.rows[Number(label)]?.[column] !== props.other?.[Number(label)]?.[column]
      }
    />
  );
}
