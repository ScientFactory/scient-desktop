import type {
  ComputeResultsAttemptOutputResult,
  ComputeResultLastAttempt,
  EnvironmentId,
} from "@t3tools/contracts";
import { normalizeTerminalOutput } from "@t3tools/shared/terminalOutput";
import { T, useGT } from "gt-react";
import { lazy, Suspense, useState } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { useActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { computeOutputBlocks } from "../compute/computeOutputBlocks";
import { computeDiagnosticSummary } from "../compute/computeResultPresentation";
import { resultErrorMessage } from "./resultState";

const ComputeOutputView = lazy(() =>
  import("../compute/ComputeOutputView").then(({ ComputeOutputView }) => ({
    default: ComputeOutputView,
  })),
);

type AttemptTextBlock =
  | { readonly key: string; readonly text: string }
  | { readonly key: string; readonly summary: string; readonly traceback: string };

export interface ResultRunFailure {
  readonly message: string;
  readonly previousAttempt: string | undefined;
}

export function ResultRunFailureNotice(props: {
  readonly failure: ResultRunFailure | null;
  readonly lastAttempt: ComputeResultLastAttempt | undefined;
}) {
  const { failure, lastAttempt } = props;
  if (failure === null || failure.previousAttempt !== lastAttempt?.finishedAt) return null;
  return (
    <p role="alert" className="text-destructive">
      {failure.message}
    </p>
  );
}

export function ResultAttemptStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly scriptPath: string;
  readonly attempt: ComputeResultLastAttempt;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<ComputeResultsAttemptOutputResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useAtomCommand(computeEnvironment.resultsAttemptOutput, { reportFailure: false });
  const hasDiagnostic = output?.output.outputs.some(({ _tag }) => _tag === "diagnostic") === true;

  const openOutput = async () => {
    setOpen(true);
    setOutput(null);
    setError(null);
    const response = await load({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, scriptPath: props.scriptPath, finishedAt: props.attempt.finishedAt },
    });
    if (response._tag === "Success") setOutput(response.value);
    else setError(resultErrorMessage(response, gt("The run output could not be read.")));
  };

  const blocks = computeOutputBlocks(output?.output.outputs ?? []).flatMap<AttemptTextBlock>(
    (block) => {
      if (block.kind === "stream")
        return [{ key: block.key, text: normalizeTerminalOutput(block.text).text }];
      const item = block.output;
      if (item._tag === "diagnostic")
        return [{ key: block.key, ...computeDiagnosticSummary(item.diagnostic) }];
      return item._tag === "system" && item.detail !== null
        ? [{ key: block.key, text: item.detail }]
        : [];
    },
  );

  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      <span className="text-foreground">
        {props.attempt.status === "failed" ? <T>Last run failed</T> : <T>Last run stopped</T>}
      </span>
      <time className="tabular-nums" dateTime={props.attempt.finishedAt}>
        <RelativeTime timestamp={props.attempt.finishedAt} />
      </time>
      <Button type="button" variant="ghost-inset" size="xs" onClick={() => void openOutput()}>
        <T>View output</T>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogPopup layer="above-popovers">
            <DialogHeader>
              <DialogTitle>
                <T>Last run output</T>
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-2 text-sm">
                {!hasDiagnostic && (output !== null || error !== null) && props.attempt.message ? (
                  <p>{props.attempt.message}</p>
                ) : null}
                {error === null ? null : <p role="alert">{error}</p>}
                {output === null && error === null ? (
                  <p role="status">
                    <T>Loading output…</T>
                  </p>
                ) : null}
                {output === null ? null : (
                  <>
                    {output.parameters && output.parameters.length > 0 ? (
                      <div className="text-xs">
                        <p className="font-medium">
                          <T>Run parameters</T>
                        </p>
                        <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-1">
                          {output.parameters.map(({ name, value }) => (
                            <div key={name} className="contents">
                              <dt className="wrap-anywhere">
                                <bdi>{name}</bdi>
                              </dt>
                              <dd className="wrap-anywhere tabular-nums">
                                <bdi>{value}</bdi>
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ) : null}
                    <AttemptOutput {...props} value={output} blocks={blocks} />
                  </>
                )}
              </div>
            </DialogPanel>
          </DialogPopup>
        ) : null}
      </Dialog>
    </div>
  );
}

function AttemptOutput(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly value: ComputeResultsAttemptOutputResult;
  readonly blocks: ReadonlyArray<AttemptTextBlock>;
}) {
  const target = useActiveProjectTarget();
  const { output, executionId, session } = props.value;
  if (output.outputs.length === 0 && output.corruptLineCount === 0)
    return (
      <p>
        <T>No run output was saved.</T>
      </p>
    );
  if (session !== null && target?.environmentId === props.environmentId)
    return (
      <Suspense
        fallback={
          <p role="status">
            <T>Loading output…</T>
          </p>
        }
      >
        <ComputeOutputView
          cwd={props.cwd}
          environmentId={props.environmentId}
          session={session}
          executionId={executionId}
          threadRef={target.threadRef}
          outputs={output.outputs}
          corruptLineCount={output.corruptLineCount}
        />
      </Suspense>
    );
  return (
    <>
      {output.corruptLineCount > 0 ? (
        <p>
          <T>Some output could not be read.</T>
        </p>
      ) : null}
      {props.blocks.map((block) =>
        "summary" in block ? (
          <div key={block.key}>
            <p className="font-medium text-destructive">{block.summary}</p>
            {block.traceback ? (
              <pre className="mt-1 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
                {block.traceback}
              </pre>
            ) : null}
          </div>
        ) : (
          <pre key={block.key} className="whitespace-pre-wrap wrap-anywhere text-xs">
            {block.text}
          </pre>
        ),
      )}
    </>
  );
}
