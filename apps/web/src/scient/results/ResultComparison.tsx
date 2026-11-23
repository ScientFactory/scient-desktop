import type {
  ComputeResultsCompareResult,
  ComputeResultsHistoryResult,
  ComputeResultSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { ArrowLeftRightIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { ScientTooltip } from "~/scient/presentation/ScientTooltip";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { ExportResultPackageButton } from "./handoff/ExportResultPackageButton";
import { ResultComparisonOutputs } from "./ResultComparisonOutputs";
import { resultParameters, resultTime } from "./resultState";

type ResultScope = { readonly environmentId: EnvironmentId; readonly cwd: string };
type CompareTarget = ResultScope & {
  readonly summary: ComputeResultSummary;
  readonly candidate?: ComputeResultSummary | undefined;
};

export function CompareResultButton(props: CompareTarget) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={trigger} size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Compare with…</T>
      </Button>
      {open ? (
        <ResultComparison
          {...props}
          onClose={() => setOpen(false)}
          finalFocus={() => trigger.current ?? false}
        />
      ) : null}
    </>
  );
}

export function ResultComparison(
  props: CompareTarget & {
    readonly onClose: () => void;
    readonly finalFocus: () => HTMLElement | false;
  },
) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        layout="visual"
        bottomStickOnMobile={false}
        padding="none"
        gap="none"
        className="@container w-full max-w-[960px] max-sm:w-full"
        finalFocus={props.finalFocus}
      >
        <CompareRevisions {...props} />
      </DialogPopup>
    </Dialog>
  );
}

function CompareRevisions(props: CompareTarget) {
  const gt = useGT();
  const messages = useMessages();
  const [selection, setSelection] = useState<readonly [string, string] | null>(null);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const history = useEnvironmentQuery(
    computeEnvironment.resultsHistory({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, scriptPath: props.summary.scriptPath },
    }),
    messages,
  );
  const revisions = history.data?.revisions ?? [];
  const choices = revisions.map((entry, index) => {
    const number = revisions.length - index;
    const label = gt("Revision {number} · {time}", {
      number,
      time: resultTime(entry.finishedAt, "medium"),
    });
    const parameters = resultParameters(entry.parameters);
    return { ...entry, number, label: parameters ? `${label} · ${parameters}` : label };
  });
  const current = choices.findIndex((entry) => entry.revision === props.summary.revision);
  const savedAt = Date.parse(props.summary.finishedAt);
  const nextNewer = choices[current - 1];
  const nextOlder = choices[current + 1];
  const nearest =
    nextNewer === undefined || nextOlder === undefined
      ? (nextNewer ?? nextOlder)
      : Math.abs(Date.parse(nextNewer.finishedAt) - savedAt) <=
          Math.abs(Date.parse(nextOlder.finishedAt) - savedAt)
        ? nextNewer
        : nextOlder;
  const preferred = choices.find(({ revision }) => revision === props.candidate?.revision);
  const [fromId, toId] = selection ?? [props.summary.revision, (preferred ?? nearest)?.revision];
  const from = choices.find(({ revision }) => revision === fromId);
  const to = choices.find(({ revision }) => revision === toId);
  const comparison = useEnvironmentQuery(
    from === undefined || to === undefined
      ? null
      : computeEnvironment.resultsCompare({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, from: from.revision, to: to.revision },
        }),
    messages,
  );

  return (
    <>
      <DialogHeader className="shrink-0">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <DialogTitle className="col-start-1 row-start-1 me-6">
            <T>Compare revisions</T>
          </DialogTitle>
          <DialogDescription className="col-span-2 row-start-2 min-w-0 wrap-anywhere">
            <bdi>{props.summary.scriptPath}</bdi>
          </DialogDescription>
          {from && to ? (
            <>
              <div className="col-span-2 row-start-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-2 border-b border-border pb-3">
                <RevisionSide
                  {...props}
                  className="col-start-1 row-start-1"
                  side={gt("From")}
                  selected={from}
                  choices={choices.filter(({ revision }) => revision !== to.revision)}
                  incomplete={incompleteInputEvidence(comparison.data?.from)}
                  onSelect={(value) => setSelection([value, to.revision])}
                />
                <RevisionSide
                  {...props}
                  className="col-start-3 row-start-1"
                  side={gt("To")}
                  selected={to}
                  choices={choices.filter(({ revision }) => revision !== from.revision)}
                  incomplete={incompleteInputEvidence(comparison.data?.to)}
                  onSelect={(value) => setSelection([from.revision, value])}
                />
                <div className="col-start-2 row-start-1 mt-4">
                  <ScientTooltip content={gt("Swap sides")}>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost-inset"
                      aria-label={gt("Swap sides")}
                      onClick={() => setSelection([to.revision, from.revision])}
                    >
                      <ArrowLeftRightIcon />
                    </Button>
                  </ScientTooltip>
                </div>
              </div>
              <label className="col-span-2 row-start-4 flex w-fit items-center gap-2 text-xs @min-[420px]:col-span-1 @min-[420px]:col-start-2 @min-[420px]:row-start-1 @min-[420px]:me-6">
                <Checkbox
                  aria-label={gt("Show unchanged")}
                  checked={showUnchanged}
                  onCheckedChange={setShowUnchanged}
                />
                <T>Show unchanged</T>
              </label>
            </>
          ) : null}
        </div>
      </DialogHeader>
      <DialogPanel className="min-w-0">
        {history.error !== null ? (
          <p role="alert">{history.error}</p>
        ) : history.data === null ? (
          <p role="status">
            <T>Loading revisions…</T>
          </p>
        ) : !from || !to ? (
          <p>
            <T>There is only one saved revision to show.</T>
          </p>
        ) : comparison.error !== null ? (
          <p role="alert">{comparison.error}</p>
        ) : comparison.data !== null ? (
          <ComparisonDetails {...props} data={comparison.data} showUnchanged={showUnchanged} />
        ) : (
          <p role="status">
            <T>Comparing revisions…</T>
          </p>
        )}
      </DialogPanel>
    </>
  );
}

type RevisionChoice = ComputeResultsHistoryResult["revisions"][number] & {
  readonly label: string;
  readonly number: number;
};

function RevisionSide(
  props: CompareTarget & {
    readonly side: string;
    readonly className: string;
    readonly selected: RevisionChoice;
    readonly choices: ReadonlyArray<RevisionChoice>;
    readonly incomplete: boolean;
    readonly onSelect: (revision: string) => void;
  },
) {
  const gt = useGT();
  const parameters = resultParameters(props.selected.parameters);
  const detailsId = useId();
  const trigger = (
    <SelectTrigger
      size="sm"
      className="w-full min-w-0"
      aria-label={gt("{side} revision", { side: props.side })}
      aria-describedby={detailsId}
    >
      <SelectValue>
        <span className="min-w-0 truncate tabular-nums">
          {gt("Revision {number}", { number: props.selected.number })}
        </span>
      </SelectValue>
    </SelectTrigger>
  );
  return (
    <div className={`grid min-w-0 gap-1 ${props.className}`}>
      <Select
        items={props.choices.map(({ revision, label }) => ({ value: revision, label }))}
        value={props.selected.revision}
        onValueChange={(value) => {
          if (value !== null) props.onSelect(value);
        }}
      >
        {parameters ? (
          <ScientTooltip content={<bdi>{parameters}</bdi>}>{trigger}</ScientTooltip>
        ) : (
          trigger
        )}
        <SelectPopup>
          {props.choices.map(({ revision, label }) => (
            <SelectItem key={revision} value={revision}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <div className="order-first flex min-w-0 items-center justify-between gap-1">
        <span className="text-sm font-medium">{props.side}</span>
        <ExportResultPackageButton
          environmentId={props.environmentId}
          cwd={props.cwd}
          scriptPath={props.summary.scriptPath}
          revision={props.selected.revision}
          menuLabel={gt("{side} revision actions", { side: props.side })}
        />
      </div>
      <div id={detailsId} className="grid min-w-0 gap-1 text-xs text-muted-foreground tabular-nums">
        <time dateTime={props.selected.finishedAt}>
          {resultTime(props.selected.finishedAt, "medium")}
        </time>
        <bdi className="truncate">{parameters || gt("No recorded parameters")}</bdi>
      </div>
      {props.incomplete ? (
        <span className="text-xs text-muted-foreground">
          <T>Input evidence is incomplete.</T>
        </span>
      ) : null}
    </div>
  );
}

function incompleteInputEvidence(summary: ComputeResultSummary | undefined) {
  return (
    summary !== undefined &&
    (summary.inputCoverageIncomplete ||
      summary.inputsTruncated ||
      summary.inputTracking === "not-tracked") === true
  );
}

type ComparisonRow = {
  readonly name: string;
  readonly field?: string;
  readonly before: ReactNode;
  readonly after: ReactNode;
  readonly change?: string | undefined;
  readonly different: boolean;
};

function ComparisonTable(props: {
  readonly heading: string;
  readonly rows: ReadonlyArray<ComparisonRow>;
  readonly numeric?: boolean;
}) {
  if (props.rows.length === 0) return null;
  const rows = props.rows.toSorted((a, b) => Number(b.different) - Number(a.different));
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium">{props.heading}</h3>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="h-7 w-2/5 text-start">
              <T>Name</T>
            </TableHead>
            <TableHead scope="col" className="h-7 text-end">
              <T>From</T>
            </TableHead>
            <TableHead scope="col" className="h-7 text-end">
              <T>To</T>
            </TableHead>
            <TableHead scope="col" className="h-7 text-end">
              {props.numeric ? "Δ" : <T>Change</T>}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ name, field, before, after, change, different }) => (
            <TableRow key={JSON.stringify([name, field])}>
              <TableHead scope="row" className="h-auto text-start whitespace-normal wrap-anywhere">
                <bdi>{field ?? name}</bdi>
                {field === undefined ? null : (
                  <bdi className="block font-normal text-muted-foreground">{name}</bdi>
                )}
              </TableHead>
              <TableCell className="min-w-0 text-end">{before ?? "–"}</TableCell>
              <TableCell className="min-w-0 text-end">{after ?? "–"}</TableCell>
              <TableCell className="text-end whitespace-normal wrap-anywhere">
                {different ? (
                  <span className="font-medium tabular-nums">{change ?? <T>Changed</T>}</span>
                ) : (
                  (change ?? "–")
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function ComparisonValue(props: { readonly value: string; readonly compact?: string | undefined }) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const compact = props.compact ?? props.value;
  return (
    <ScientTooltip content={<bdi className="whitespace-pre-wrap wrap-anywhere">{props.value}</bdi>}>
      <Button
        variant="ghost-inset"
        size="toolbar"
        className="max-w-full justify-end"
        aria-label={
          isCopied
            ? gt("Copied {value}", { value: props.value })
            : gt("Copy {value}", { value: props.value })
        }
        onClick={() => copyToClipboard(props.value, undefined)}
      >
        <bdi className="truncate text-xs tabular-nums">{compact}</bdi>
      </Button>
    </ScientTooltip>
  );
}

function ComparisonDetails(
  props: ResultScope & {
    readonly data: ComputeResultsCompareResult;
    readonly showUnchanged: boolean;
  },
) {
  const gt = useGT();
  const { data, showUnchanged } = props;
  const formatDelta = new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 5,
    signDisplay: "exceptZero",
  });
  const formatRelative = new Intl.NumberFormat(undefined, {
    maximumSignificantDigits: 4,
    signDisplay: "exceptZero",
    style: "percent",
  });
  const changes = {
    added: gt("Added"),
    removed: gt("Removed"),
    changed: gt("Changed"),
    same: gt("Same"),
  };
  const parameters = data.parameters.filter(({ from, to }) => showUnchanged || from !== to);
  const inputs = data.inputs.filter(
    ({ change, evidence, contentUnchecked }) =>
      showUnchanged || change !== "same" || evidence !== undefined || contentUnchecked,
  );
  const inputEvidence = (
    entry: NonNullable<ComputeResultsCompareResult["inputs"][number]["evidence"]>["from"],
  ) => (
    <span className="whitespace-normal wrap-anywhere">
      {entry.origin === "both"
        ? gt("Declared and observed")
        : entry.origin === "declared"
          ? gt("Declared")
          : gt("Observed")}
      {entry.via === undefined ? null : (
        <bdi className="block text-muted-foreground">{entry.via}</bdi>
      )}
      {entry.changedDuringRun ? (
        <span className="block text-muted-foreground">
          <T>Changed during run</T>
        </span>
      ) : null}
    </span>
  );
  const outputs = data.outputs
    .filter(({ change }) => showUnchanged || change !== "same")
    .toSorted((a, b) => Number(a.change === "same") - Number(b.change === "same"));
  const values = data.values.filter(
    ({ from, to, typeChanged }) => showUnchanged || from !== to || typeChanged,
  );
  const evidence = data.environmentEvidence;
  const runtime = (run: ComputeResultsCompareResult["runtime"]["from"], language: string) => {
    const label = [language, run.version].filter(Boolean).join(" ");
    return run.executable === null ? (
      label
    ) : (
      <ComparisonValue value={run.executable} compact={label} />
    );
  };
  const valueCell = (value: string | null, compact?: string) =>
    value === null ? null : <ComparisonValue value={value} compact={compact} />;
  const hasChanges =
    data.codeChanged ||
    data.runtime.changed ||
    parameters.length > 0 ||
    inputs.length > 0 ||
    outputs.length > 0 ||
    values.length > 0 ||
    data.environment.length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!showUnchanged && !hasChanges && !data.valuesTruncated ? (
        <p>
          <T>No differences found in the records shown.</T>
        </p>
      ) : null}
      {showUnchanged || data.codeChanged ? (
        <p>
          <strong>
            <T>Code</T>
          </strong>
          {" · "}
          {data.codeChanged ? gt("Changed") : gt("Same")}
        </p>
      ) : null}
      <ComparisonTable
        heading={gt("Parameters")}
        rows={parameters.map(({ name, from, to }) => ({
          name,
          before: valueCell(from),
          after: valueCell(to),
          different: from !== to,
        }))}
      />
      {data.from.kind !== "notebook" || data.to.kind !== "notebook" ? (
        <p className="text-xs text-muted-foreground">
          <T>
            Script parameters show values passed to the run. Defaults inside the script are not
            recorded.
          </T>
        </p>
      ) : null}
      <ComparisonTable
        heading={gt("Inputs")}
        rows={inputs.map(({ path, change, evidence, contentUnchecked }) => ({
          name: path,
          before: evidence
            ? inputEvidence(evidence.from)
            : change === "added"
              ? null
              : gt("Recorded"),
          after: evidence
            ? inputEvidence(evidence.to)
            : change === "removed"
              ? null
              : gt("Recorded"),
          change: contentUnchecked ? gt("Bytes not compared") : changes[change],
          different: change !== "same",
        }))}
      />
      {showUnchanged || data.runtime.changed ? (
        <ComparisonTable
          heading={gt("Runtime")}
          rows={[
            {
              name: gt("Interpreter"),
              before: runtime(data.runtime.from, data.from.language),
              after: runtime(data.runtime.to, data.to.language),
              different: data.runtime.changed,
            },
          ]}
        />
      ) : null}
      <ComparisonTable
        heading={gt("Environment")}
        rows={data.environment.map(({ name, from, to, kind }) => ({
          name:
            kind === "lockfile"
              ? gt("Lockfile · {name}", { name })
              : gt("Package · {name}", { name }),
          before: valueCell(from, kind === "lockfile" ? from?.slice(0, 12) : undefined),
          after: valueCell(to, kind === "lockfile" ? to?.slice(0, 12) : undefined),
          different: true,
        }))}
      />
      {evidence &&
      (!evidence.fromLockfiles ||
        !evidence.toLockfiles ||
        !evidence.fromPackages ||
        !evidence.toPackages ||
        evidence.packagesTruncated) ? (
        <p className="text-xs text-muted-foreground">
          <T>Environment evidence is incomplete for at least one revision.</T>
        </p>
      ) : null}
      <ComparisonTable
        heading={gt("Values")}
        numeric
        rows={values.map(({ output, pointer, from, to, delta, relativeChange, typeChanged }) => ({
          name: output,
          field: pointer,
          before: valueCell(from),
          after: valueCell(to),
          different: from !== to || typeChanged === true,
          change: typeChanged
            ? gt("Type changed")
            : delta !== undefined
              ? relativeChange === undefined
                ? formatDelta.format(delta)
                : gt("{delta} ({relative})", {
                    delta: formatDelta.format(delta),
                    relative: formatRelative.format(relativeChange),
                  })
              : from !== to
                ? gt("Changed")
                : undefined,
        }))}
      />
      {data.valuesTruncated ? (
        <p className="text-xs text-muted-foreground">
          <T>Only the first 500 changed value pairs are shown.</T>
        </p>
      ) : null}
      {outputs.some(({ kind }) => kind === "file" || kind === "latex") ? (
        <section>
          <h3 className="font-medium">
            <T>Other files</T>
          </h3>
          <ul className="text-xs">
            {outputs
              .filter(({ kind }) => kind === "file" || kind === "latex")
              .map(({ name, change }) => (
                <li key={name}>
                  <bdi>{name}</bdi>
                  {" · "}
                  {changes[change]}
                </li>
              ))}
          </ul>
        </section>
      ) : null}
      {(["figure", "table"] as const).map((kind) => (
        <ResultComparisonOutputs
          key={kind}
          kind={kind}
          environmentId={props.environmentId}
          cwd={props.cwd}
          from={data.from}
          to={data.to}
          outputs={outputs}
        />
      ))}
    </div>
  );
}
