import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DataViewError, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { use, useId, useState } from "react";

import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field, FieldControl, FieldLabel } from "~/components/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { MenuItem } from "~/components/ui/menu";
import { Input } from "~/components/ui/input";
import { useAtomCommand } from "~/state/use-atom-command";

import { GridActionMenuContext } from "./gridActionMenu";
import type { DataGridView } from "./DataGrid";
import { materializeDataView, saveDataView } from "./dataTableState";

const isDataViewError = Schema.is(DataViewError);
const exportExtension = /\.(csv|parquet)$/iu;
type ExportFormat = "csv" | "parquet";

const withFormat = (path: string, format: ExportFormat) =>
  exportExtension.exec(path)?.[1]?.toLowerCase() === format
    ? path
    : `${path.replace(exportExtension, "")}.${format}`;

export interface DataWorkspaceFile {
  readonly cwd: string;
  readonly path: string;
  readonly onOpenPath: (path: string) => void;
}

export function DataViewActions(
  props: {
    readonly file: DataWorkspaceFile;
    readonly view: DataGridView;
    readonly environmentId: EnvironmentId;
  } & (
    | { readonly kind: "save" }
    | {
        readonly kind: "export";
        readonly revision: string;
        readonly onFailure: (failure: unknown) => void;
      }
  ),
) {
  const gt = useGT();
  const menu = use(GridActionMenuContext);
  const { kind, file, environmentId, view } = props;
  const command = kind === "save" ? saveDataView : materializeDataView;
  const permission = useAtomValue(command.permissionAtom(environmentId));
  const save = useAtomCommand(saveDataView, { reportFailure: false });
  const materialize = useAtomCommand(materializeDataView, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWithoutSearch, setConfirmWithoutSearch] = useState(false);
  const formatId = useId();
  const [format, setFormat] = useState<ExportFormat>("parquet");
  const [destination, setDestination] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const title = kind === "save" ? gt("Save as view…") : gt("Export derived table…");

  const onOpenChange = (next: boolean) => {
    if (busy) return;
    if (next) {
      const base =
        file.path
          .split("/")
          .at(-1)
          ?.replace(/\.[^.]+$/u, "") || "table";
      setFormat("parquet");
      setDestination(kind === "save" ? `views/${base}.sql` : `${base}.parquet`);
      setSelected(
        new Set(
          view.columns
            .map((_, index) => index)
            .filter(
              (index) =>
                !view.selectedColumns ||
                (index >= view.selectedColumns.first && index <= view.selectedColumns.last),
            ),
        ),
      );
      setError(null);
      setConfirmWithoutSearch(false);
    }
    setOpen(next);
  };

  const write = async () => {
    setBusy(true);
    setError(null);
    const projectPath = destination.trim();
    const input = {
      cwd: file.cwd,
      path: file.path,
      destination: kind === "export" ? withFormat(projectPath, format) : projectPath,
    };
    const result = await (
      kind === "save"
        ? save({
            environmentId,
            input: {
              ...input,
              search: confirmWithoutSearch ? "" : view.search,
              sort: view.sort,
              ...(view.minimum === null ? {} : { minimum: view.minimum }),
              columns: [...selected].toSorted((a, b) => a - b),
            },
          })
        : materialize({
            environmentId,
            input: {
              ...input,
              revision: props.revision,
              filter: {
                search: view.search,
                sort: view.sort,
                ...(view.minimum === null ? {} : { minimum: view.minimum }),
              },
            },
          })
    ).finally(() => setBusy(false));
    if (result._tag === "Success") {
      setOpen(false);
      file.onOpenPath(result.value.path);
    } else {
      const failure = squashAtomCommandFailure(result);
      if (props.kind === "export") props.onFailure(failure);
      if (isDataViewError(failure) && failure.reason === "search-not-saved") {
        setConfirmWithoutSearch(true);
        setError(
          gt(
            "Search isn’t saved: Scient couldn’t verify that DuckDB returns the same rows as the grid.",
          ),
        );
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
  };

  if (menu === null) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <MenuItem
        focus="edge"
        disabled={!permission}
        onClick={() => menu.launch(() => onOpenChange(true))}
      >
        {kind === "export" ? gt("Export table…") : title}
      </MenuItem>
      <DialogPopup finalFocus={menu.finalFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            {kind === "save"
              ? gt(
                  "Save the current filters, search, sort and selected columns as a DuckDB SQL file.",
                )
              : gt(
                  "Export all rows from {view} that match the grid’s search and filters, in grid order.",
                  {
                    view: file.path,
                  },
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void write();
          }}
        >
          <DialogPanel>
            <div className="grid gap-4 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)]">
              {kind === "export" ? (
                <Field className="min-w-0">
                  <FieldLabel htmlFor={formatId}>{gt("Format")}</FieldLabel>
                  <Select
                    value={format}
                    disabled={busy}
                    onValueChange={(next) => {
                      if (next === null) return;
                      setFormat(next);
                      setDestination((path) =>
                        path.trim() ? withFormat(path.trimEnd(), next) : path,
                      );
                    }}
                  >
                    <SelectTrigger id={formatId} className="w-full">
                      <SelectValue>{format === "csv" ? gt("CSV") : gt("Parquet")}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start">
                      <SelectItem value="csv">{gt("CSV")}</SelectItem>
                      <SelectItem value="parquet">{gt("Parquet")}</SelectItem>
                    </SelectPopup>
                  </Select>
                </Field>
              ) : null}
              <Field className={kind === "save" ? "sm:col-span-2" : undefined}>
                <FieldLabel>{gt("Project file path")}</FieldLabel>
                <FieldControl
                  render={<Input />}
                  value={destination}
                  disabled={busy}
                  onChange={(event) => {
                    const path = event.currentTarget.value;
                    setDestination(path);
                    if (kind === "export") {
                      const extension = exportExtension.exec(path.trim())?.[1]?.toLowerCase();
                      if (extension === "csv" || extension === "parquet") setFormat(extension);
                    }
                  }}
                />
              </Field>
            </div>
            {kind === "save" &&
            view.search.trim() &&
            !confirmWithoutSearch &&
            /\.(csv|tsv|tab)$/iu.test(file.path) ? (
              <p className="text-sm text-muted-foreground">
                {gt("To preserve the search, the view reads each column as text.")}
              </p>
            ) : null}
            {kind === "save" ? (
              <fieldset className="max-h-48 overflow-auto" disabled={busy}>
                <legend className="text-sm font-medium">{gt("Columns to include")}</legend>
                {view.columns.map((column, index) => (
                  <label key={column.name} className="flex items-center gap-2 py-1 text-sm">
                    <Checkbox
                      checked={selected.has(index)}
                      onCheckedChange={(checked) => {
                        const next = new Set(selected);
                        if (checked) next.add(index);
                        else next.delete(index);
                        setSelected(next);
                      }}
                    />
                    {column.name}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose
              render={<Button focus="edge" variant="outline" type="button" />}
              disabled={busy}
            >
              {gt("Cancel")}
            </DialogClose>
            <Button
              focus="edge"
              type="submit"
              disabled={
                busy ||
                !permission ||
                !destination.trim() ||
                destination.trimEnd().endsWith("/") ||
                (kind === "save" && selected.size === 0)
              }
            >
              {busy
                ? gt("Writing file…")
                : confirmWithoutSearch
                  ? gt("Save without search")
                  : kind === "save"
                    ? gt("Save view")
                    : gt("Export table")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
