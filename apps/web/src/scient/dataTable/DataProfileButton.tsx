import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DataProfile, DataProfileEvent, EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useAtomCommand } from "~/state/use-atom-command";

import { DataColumnTypeLabel } from "./DataColumnTypeLabel";
import { dataProfile, type ProfileTarget } from "./dataTableState";

export function DataProfileButton(props: {
  readonly environmentId: EnvironmentId;
  readonly target: ProfileTarget;
  readonly sourceLabel: string;
  readonly onFailure?: (failure: unknown) => void;
}) {
  const gt = useGT();
  const execute = useAtomCommand(dataProfile, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [sampleRequested, setSampleRequested] = useState(false);
  const [event, setEvent] = useState<DataProfileEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the outstanding RPC when its consumer unmounts.
  useEffect(() => () => controller.current?.abort(), []);

  const close = () => {
    controller.current?.abort();
    setOpen(false);
  };

  const start = (sampleOnly = false) => {
    const target =
      sampleOnly && props.target.kind === "file"
        ? { ...props.target, input: { ...props.target.input, sampleOnly: true } }
        : props.target;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setSampleRequested(sampleOnly);
    setEvent(null);
    setError(null);
    setOpen(true);
    void execute({
      environmentId: props.environmentId,
      target,
      signal: request.signal,
      onEvent: (value) => {
        if (!request.signal.aborted) setEvent(value);
      },
    }).then((result) => {
      if (!request.signal.aborted && result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        props.onFailure?.(failure);
        setError(String(failure));
      }
    });
  };

  const progress = event?._tag === "Progress" ? event : null;
  const profile = event?._tag === "Complete" ? event.profile : null;
  const busy = error === null && profile === null;
  const canShowSample =
    !sampleRequested &&
    props.target.kind === "file" &&
    /\.parquet$/iu.test(props.target.input.path);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? start() : close())}>
      <DialogTrigger render={<Button focus="edge" variant="ghost" size="xs" />}>
        {gt("Column profile")}
      </DialogTrigger>
      <DialogPopup size="wide" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>{gt("Column profile")}</DialogTitle>
          <div className="flex flex-wrap items-center gap-2">
            <DialogDescription className="min-w-0 flex-1 wrap-anywhere">
              {busy ? (
                <span role="status" className="tabular-nums">
                  {progress?.target == null
                    ? canShowSample
                      ? gt("Profiling all rows in {source}…", { source: props.sourceLabel })
                      : gt("Preparing the profile for {source}…", { source: props.sourceLabel })
                    : gt("{done} of {target} rows inspected in {source}", {
                        done: progress.rowsProfiled.toLocaleString(),
                        target: progress.target.toLocaleString(),
                        source: props.sourceLabel,
                      })}
                </span>
              ) : profile === null ? (
                props.sourceLabel
              ) : (
                profileScope(profile, props.sourceLabel, gt)
              )}
              {" · "}
              {gt("Before grid search and filters")}
            </DialogDescription>
            {busy ? (
              <div className="flex flex-wrap items-center gap-2">
                {canShowSample ? (
                  <Button focus="edge" variant="ghost" size="sm" onClick={() => start(true)}>
                    {gt("Show sample")}
                  </Button>
                ) : null}
                <Button focus="edge" variant="outline" size="sm" onClick={close}>
                  {gt("Cancel")}
                </Button>
              </div>
            ) : null}
          </div>
        </DialogHeader>
        <DialogPanel>
          {profile === null ? null : <ProfileTable profile={profile} />}
          {error === null ? null : <p role="alert">{error}</p>}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function profileScope(profile: DataProfile, source: string, gt: ReturnType<typeof useGT>) {
  const count = profile.rowsProfiled.toLocaleString();
  if (profile.scope === "all") return gt("All {count} rows in {source}", { count, source });
  return profile.rowCount === null
    ? gt("First {count} rows in {source} · total unknown", { count, source })
    : gt("First {count} rows of {total} in {source}", {
        count,
        total: profile.rowCount.toLocaleString(),
        source,
      });
}

function ProfileTable({ profile }: { readonly profile: DataProfile }) {
  const gt = useGT();
  const mixed =
    profile.scope === "sample" &&
    profile.columns.some(
      (column) => column.missingFromFooter || column.distinctFromFooter || column.rangeFromFooter,
    );
  const scopeLabel = (fromFooter: boolean) =>
    !mixed
      ? null
      : fromFooter
        ? gt("All rows")
        : gt("Sample · first {count} rows", { count: profile.rowsProfiled.toLocaleString() });
  return (
    <div className="min-w-0 space-y-2">
      {profile.columnCount > profile.columns.length ? (
        <p className="text-sm text-muted-foreground">
          {gt("Showing the first {count} columns.", {
            count: profile.columns.length.toLocaleString(),
          })}
        </p>
      ) : null}
      <Table
        containerProps={{
          role: "region",
          tabIndex: 0,
          "aria-label": gt("Column statistics"),
          className:
            "max-h-[55dvh] overflow-auto focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring",
        }}
      >
        <TableHeader sticky>
          <TableRow>
            {[
              gt("Column"),
              gt("Type"),
              gt("Missing"),
              gt("Distinct"),
              gt("Range or top values"),
            ].map((label, index) => (
              <TableHead key={label} scope="col" numeric={index >= 2}>
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {profile.columns.map(
            ({
              columnIndex,
              column,
              missing,
              nanCount,
              missingShare,
              missingFromFooter,
              distinct,
              distinctFromFooter,
              distinctApproximate,
              distinctLowerBound,
              valuesClipped,
              range,
              rangeFromFooter,
              topTracked,
              topApproximate,
              top,
            }) => (
              <TableRow key={columnIndex}>
                <TableHead
                  scope="row"
                  className="max-w-48 text-start whitespace-normal wrap-anywhere"
                >
                  {column.name}
                </TableHead>
                <TableCell className="align-top">
                  <DataColumnTypeLabel column={column} />
                </TableCell>
                <TableCell numeric className="align-top">
                  {missing.toLocaleString()}
                  {missingShare === null
                    ? null
                    : ` (${missingShare.toLocaleString(undefined, { style: "percent", maximumFractionDigits: 2 })})`}
                  {nanCount === undefined ? null : (
                    <div className="text-xs text-muted-foreground">
                      {gt("{count} NaN", { count: nanCount.toLocaleString() })}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {missingFromFooter && mixed ? gt("File nulls · all rows") : scopeLabel(false)}
                  </div>
                </TableCell>
                <TableCell numeric className="align-top">
                  {distinctLowerBound
                    ? gt("At least {count}", { count: distinct.toLocaleString() })
                    : distinctApproximate
                      ? gt("≈{count}", { count: distinct.toLocaleString() })
                      : distinct.toLocaleString()}
                  <div className="text-xs text-muted-foreground">
                    {scopeLabel(distinctFromFooter)}
                  </div>
                </TableCell>
                <TableCell numeric className="max-w-64 align-top whitespace-normal wrap-anywhere">
                  {range
                    ? gt("{min} to {max}", range)
                    : top.map(({ value, count }) => (
                        <div key={value}>
                          {gt("{value} ({count})", {
                            value: value || gt("(empty text)"),
                            count: count.toLocaleString(),
                          })}
                        </div>
                      ))}
                  {range || top.length ? (
                    <div className="text-xs text-muted-foreground">
                      {scopeLabel(rangeFromFooter)}
                    </div>
                  ) : null}
                  {topApproximate && top.length ? (
                    <div className="text-xs text-muted-foreground">
                      {gt("Common values selected by estimate")}
                    </div>
                  ) : null}
                  {topTracked && top.length ? (
                    <div className="text-xs text-muted-foreground">
                      {gt("Most frequent among tracked values")}
                    </div>
                  ) : null}
                  {valuesClipped ? (
                    <span className="text-muted-foreground">{gt("Long values shortened")}</span>
                  ) : null}
                </TableCell>
              </TableRow>
            ),
          )}
        </TableBody>
      </Table>
    </div>
  );
}
