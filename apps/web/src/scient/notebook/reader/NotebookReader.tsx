import type {
  EnvironmentId,
  NotebookAlternatives,
  NotebookView,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { notebookParameters } from "@t3tools/shared/notebookParameters";
import { msg, T, useGT, useMessages } from "gt-react";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { scientEnvironmentFileSurface } from "~/scient/rightPanel/surfaces";
import { resultTime } from "~/scient/results/resultState";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { NotebookCodeHeader, NotebookCodeSource, notebookCodeCardSurface } from "../NotebookCode";
import { NotebookParameterControls } from "../NotebookParameters";
import { NOTEBOOK_MARKDOWN } from "../NotebookOutputs";
import {
  alternativeAt,
  parameterValues,
  readerBaseline,
  renderAlternativeProse,
} from "./notebookReaderModel";

type Alternative = NotebookAlternatives["runs"][number];

function distinctRows<A>(rows: ReadonlyArray<A>) {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const signature = JSON.stringify(row);
    const repeats = seen.get(signature) ?? 0;
    seen.set(signature, repeats + 1);
    return { key: `${signature}:${repeats}`, row };
  });
}

function SavedOutputs(props: {
  readonly alternative: Alternative;
  readonly threadRef: ScopedThreadRef;
}) {
  const { alternative } = props;
  const messages = useMessages();
  if (alternative.outputs.length === 0 && alternative.values.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        <T>This run saved no values, tables or figures to the results folder.</T>
      </p>
    );
  }
  return (
    <div className="grid gap-4">
      {alternative.outputs.map(({ name, preview, retainedPath }) => (
        <figure key={name} className="grid min-w-0 gap-1">
          <figcaption className="wrap-anywhere text-xs text-muted-foreground" dir="auto">
            {name}
          </figcaption>
          {preview?._tag === "figure" ? (
            <img
              className="max-w-full"
              alt={name}
              src={`data:${preview.mediaType};base64,${preview.data}`}
            />
          ) : preview?._tag === "table" ? (
            <div className="min-w-0 tabular-nums">
              <Table aria-label={name}>
                <TableHeader>
                  <TableRow>
                    {distinctRows(preview.rows[0] ?? []).map(({ row: cell, key }) => (
                      <TableHead key={key} scope="col">
                        {cell}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {distinctRows(preview.rows.slice(1)).map(({ row, key }) => (
                    <TableRow key={key}>
                      {distinctRows(row).map(({ row: cell, key }) => (
                        <TableCell key={key}>{cell}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {preview.partial ? (
                <p className="text-xs text-muted-foreground">
                  <T>Showing the start of the table.</T>
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm text-muted-foreground">
                <T>Preview unavailable</T>
              </p>
              {retainedPath === undefined ? null : (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  focus="edge"
                  onClick={() =>
                    useRightPanelStore
                      .getState()
                      .openScient(
                        props.threadRef,
                        scientEnvironmentFileSurface({ path: retainedPath }),
                      )
                  }
                >
                  {messages(msg("Open in file viewer"))}
                </Button>
              )}
            </div>
          )}
        </figure>
      ))}
      {alternative.values.length > 0 ? (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm tabular-nums">
          {alternative.values.map((value) => (
            <div key={`${value.output}:${value.pointer}`} className="contents">
              <dt className="break-all text-muted-foreground" dir="auto">
                {value.output} {value.pointer}
              </dt>
              <dd className="wrap-break-word" dir="auto">
                {value.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function ReaderCode({ source, language }: { readonly source: string; readonly language: string }) {
  const theme = useRenderedAppearance();
  const [wrapped, setWrapped] = useState(true);
  // Readers come for the prose and results; code starts folded to one row.
  const [folded, setFolded] = useState(true);
  return (
    <div className={cn("border border-(--markdown-code-block-border)", notebookCodeCardSurface)}>
      <NotebookCodeHeader
        language={language}
        theme={theme}
        wrapped={wrapped}
        onWrapChange={setWrapped}
        readCode={() => source}
        folded={folded}
        onFoldChange={setFolded}
      />
      {folded ? null : (
        <NotebookCodeSource
          source={source}
          language={language}
          theme={theme}
          wrapped={wrapped}
          lineNumbers
        />
      )}
    </div>
  );
}

export function NotebookReader(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly settledRunId: string | null;
  readonly fileRevision: string;
  readonly onRunForValue?: (values: Readonly<Record<string, string>>) => void;
  readonly running?: boolean;
}) {
  const gt = useGT();
  const read = useAtomCommand(computeEnvironment.notebookRead, { reportFailure: false });
  const [notebook, setNotebook] = useState<NotebookView | null | "failed">(null);
  const loadedKey = useRef<string | null>(null);
  const [pending, setPending] = useState<Readonly<Record<string, string>>>({});

  const readSaved = useStableCallback(async () => {
    const result = await read({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, path: props.relativePath, includeAlternatives: true },
    });
    return result._tag === "Success" && result.value !== null ? result.value : "failed";
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the saved notebook and revisions without a Compute session.
  useEffect(() => {
    const key = JSON.stringify([
      props.environmentId,
      props.cwd,
      props.relativePath,
      props.settledRunId,
      props.fileRevision,
    ]);
    if (loadedKey.current === key) return;
    let active = true;
    void readSaved().then((result) => {
      if (!active) return;
      loadedKey.current = key;
      setNotebook(result);
    });
    return () => {
      active = false;
    };
  }, [
    readSaved,
    props.environmentId,
    props.cwd,
    props.relativePath,
    props.settledRunId,
    props.fileRevision,
  ]);

  if (notebook === null || notebook === "failed") {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {notebook === null ? (
          <T>Loading saved results…</T>
        ) : (
          <T>The saved notebook could not be read.</T>
        )}
      </p>
    );
  }

  const parameters = notebookParameters(
    notebook.cells.find((cell) => cell.parameterCell),
    notebook.language,
  );
  const alternatives = notebook.alternatives?.runs ?? [];
  const sourceSha256 = notebook.alternatives?.currentSourceSha256;
  const baseline = readerBaseline(
    alternatives,
    notebook.alternatives?.publishedRevision,
    sourceSha256,
  );
  const { current: selected, sourceStatus } = alternativeAt(
    alternatives,
    baseline,
    pending,
    sourceSha256,
  );
  const setting = baseline === undefined ? {} : parameterValues(baseline.parameters);
  const source = selected?.source ?? notebook;

  const shownParameters = parameters.filter((parameter) => Object.hasOwn(setting, parameter.name));
  const revisionIds = new Set(alternatives.map((run) => run.revision));
  const missing = gt("Value unavailable");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="max-h-52 shrink-0 overflow-auto border-b border-border/60">
        {shownParameters.length === 0 ? null : (
          <NotebookParameterControls
            parameters={shownParameters}
            pending={{ ...setting, ...pending }}
            onChange={(name, value) => setPending((current) => ({ ...current, [name]: value }))}
          />
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <div
            role="status"
            aria-label={gt("Saved run status")}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            <span className="text-sm font-medium">
              {selected !== null ? (
                <T>Saved run</T>
              ) : alternatives.length > 0 ? (
                <T>No saved run at these values</T>
              ) : (
                <T>No published run</T>
              )}
            </span>{" "}
            {selected?.finishedAt !== undefined ? (
              <time
                dateTime={selected.finishedAt}
                className="text-xs text-muted-foreground tabular-nums"
              >
                {resultTime(selected.finishedAt)}
              </time>
            ) : null}
            {sourceStatus === "unconfirmed" ? (
              <span className="text-xs text-muted-foreground">
                <T>Notebook source unconfirmed</T>
              </span>
            ) : sourceStatus === "earlier" ? (
              <span className="text-xs text-muted-foreground">
                <T>Made with earlier code</T>
              </span>
            ) : null}
          </div>
          {(sourceStatus === "earlier" || sourceStatus === "unconfirmed") && props.onRunForValue ? (
            <Button
              size="xs"
              variant="outline"
              focus="edge"
              disabled={props.running}
              onClick={() => props.onRunForValue?.({ ...setting, ...pending })}
            >
              <T>Run for this value</T>
            </Button>
          ) : null}
          {shownParameters.length === 0 ? null : (
            <Button
              size="xs"
              variant="ghost-muted"
              focus="edge"
              disabled={Object.keys(pending).length === 0}
              onClick={() => setPending({})}
            >
              <T>Reset</T>
            </Button>
          )}
        </div>
      </div>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
        <article className="mx-auto grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-4 px-5 py-4">
          {source.cells
            .filter(
              (cell) =>
                selected === null || selected.source !== undefined || !cell.injectedParameters,
            )
            .map((cell) =>
              cell.cellType === "markdown" ? (
                <ChatMarkdown
                  key={cell.id}
                  text={renderAlternativeProse(cell.source, revisionIds, selected, missing)}
                  cwd={props.cwd}
                  parseRawHtml={false}
                  extensions={NOTEBOOK_MARKDOWN}
                />
              ) : cell.source === "" ? null : cell.cellType === "code" ? (
                <ReaderCode key={cell.id} source={cell.source} language={source.language} />
              ) : (
                <Collapsible key={cell.id}>
                  <CollapsibleTrigger
                    className="group"
                    render={(trigger, state) => (
                      <Button
                        {...trigger}
                        size="row"
                        variant={state.open ? "selected" : "ghost-muted"}
                        focus="edge"
                      />
                    )}
                  >
                    <ChevronRight
                      aria-hidden
                      className="rtl:rotate-180 group-aria-expanded:rotate-90 rtl:group-aria-expanded:rotate-90"
                    />
                    <T>Raw cell</T>
                  </CollapsibleTrigger>
                  <CollapsiblePanel animate={false}>
                    <pre
                      className="scient-content-scrollbar mt-1 overflow-x-auto rounded-lg bg-muted/40 p-2 text-sm"
                      dir="auto"
                    >
                      {cell.source}
                    </pre>
                  </CollapsiblePanel>
                </Collapsible>
              ),
            )}
          {(notebook.alternatives?.prunedRuns ?? 0) > 0 ? (
            <p className="text-xs text-muted-foreground">
              <T>Showing recent saved runs.</T>
            </p>
          ) : null}
          {selected === null ? null : (
            <SavedOutputs alternative={selected} threadRef={props.threadRef} />
          )}
        </article>
      </div>
    </div>
  );
}
