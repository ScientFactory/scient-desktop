import type {
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeProjectedOutput,
  ComputeRuntimeInspection,
  ComputeSessionRecord,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { selectComputeRepresentation } from "@t3tools/contracts";
import { CircleAlert, Info } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { useRightPanelStore } from "~/rightPanelStore";

import { computeFigurePresentation } from "./computeFigurePresentation";
import { ComputeFigure } from "./ComputeFigure";
import {
  computeProjectedStaticImage,
  computeSystemEventLabel,
  projectComputeFigureOutputs,
} from "./computeResultPresentation";
import { computeRichRepresentation } from "./computeRichRepresentation";
import { ComputeRichOutput } from "./ComputeRichOutput";
import { computeDependencyRecovery } from "./computeDependencyRecovery";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];

function outputKey(output: ComputeProjectedOutput, index: number): string {
  return `${output.sequence}:${output._tag}:${index}`;
}

function projectOutputsWithFigureOrdinals(outputs: ReadonlyArray<ComputeOutput>) {
  let displayOrdinal = 0;
  let runtimeDisplayOrdinal = 0;

  return projectComputeFigureOutputs(outputs).map((output) => {
    if (output._tag === "image") {
      displayOrdinal += 1;
      if (output.origin?._tag === "runtime-display") runtimeDisplayOrdinal += 1;
    } else if (
      output._tag === "representation" &&
      computeRichRepresentation(output) === null &&
      computeProjectedStaticImage(output) !== null
    ) {
      displayOrdinal += 1;
      runtimeDisplayOrdinal += 1;
    }

    return { output, displayOrdinal, runtimeDisplayOrdinal } as const;
  });
}

function ComputeRepresentationFallback(props: {
  readonly output: Extract<ComputeProjectedOutput, { readonly _tag: "representation" }>;
}) {
  const selection = selectComputeRepresentation(props.output.bundle, ["text/plain"]);
  if (selection._tag === "supported" && selection.representation.data._tag === "text") {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {selection.representation.data.text}
      </pre>
    );
  }
  return (
    <div className="flex items-start gap-2 text-[11px] text-muted-foreground">
      <Info className="mt-0.5 size-3 shrink-0" />
      <span>
        No available renderer for{" "}
        {props.output.bundle.representations.map((item) => item.mediaType).join(", ")}.
      </span>
    </div>
  );
}

type DiagnosticFrame = Extract<
  ComputeOutput,
  { readonly _tag: "diagnostic" }
>["diagnostic"]["frames"][number];

function ComputeDiagnosticFrames(props: {
  readonly frames: ReadonlyArray<DiagnosticFrame>;
  readonly threadRef: ScopedThreadRef;
}) {
  if (props.frames.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {props.frames.slice(-6).map((frame) => (
        <button
          key={`${frame.relativePath}:${String(frame.line)}:${String(frame.column)}:${frame.functionName ?? ""}`}
          type="button"
          className="cursor-pointer rounded-[4px] bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() =>
            useRightPanelStore
              .getState()
              .openFile(props.threadRef, frame.relativePath, frame.line ?? undefined)
          }
        >
          {frame.relativePath}
          {frame.line === null ? "" : `:${String(frame.line)}`}
          {frame.functionName === null ? "" : ` · ${frame.functionName}`}
        </button>
      ))}
    </div>
  );
}

export function ComputeOutputView(props: {
  readonly allowFigureFollowing?: boolean;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly session: ComputeSessionRecord;
  readonly executionId: ComputeExecutionId | null;
  readonly executionGeneration?: ComputeSessionRecord["generation"];
  readonly outputs: ReadonlyArray<ComputeOutput>;
  readonly emptyLabel?: string;
  readonly corruptLineCount?: number;
  readonly clipped?: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly source?: ComputeExecutionSource | null;
  readonly runtimeInspection?: ComputeRuntimeInspection | null;
}) {
  if (props.outputs.length === 0 && !props.corruptLineCount && !props.clipped) {
    return <p className="text-xs text-muted-foreground">{props.emptyLabel ?? "No output."}</p>;
  }

  return (
    <div className="space-y-2">
      {props.clipped ? (
        <p className="text-[11px] text-warning">
          Earlier live output is hidden. The complete result remains available in run history.
        </p>
      ) : null}
      {props.corruptLineCount ? (
        <p className="text-[11px] text-destructive">
          Part of this result could not be read ({props.corruptLineCount} line
          {props.corruptLineCount === 1 ? "" : "s"}).
        </p>
      ) : null}
      {projectOutputsWithFigureOrdinals(props.outputs).map(
        ({ output, displayOrdinal, runtimeDisplayOrdinal }, index) => {
          switch (output._tag) {
            case "stream":
              return (
                <pre
                  key={outputKey(output, index)}
                  className={
                    output.stream === "stderr"
                      ? "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive"
                      : "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
                  }
                >
                  {output.text}
                </pre>
              );
            case "diagnostic": {
              const recovery = computeDependencyRecovery({
                diagnostic: output.diagnostic,
                session: props.session,
                inspection: props.runtimeInspection ?? null,
              });
              return (
                <div
                  key={outputKey(output, index)}
                  className="rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs"
                >
                  <div className="flex items-start gap-2">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                    <div className="min-w-0">
                      <p className="font-medium text-destructive">
                        {output.diagnostic.errorName}: {output.diagnostic.message}
                      </p>
                      {recovery !== null ? (
                        <div className="mt-1 text-muted-foreground">
                          <p>
                            {recovery.managedHasPackage
                              ? `Scient-managed Python reports ${recovery.moduleName} installed.`
                              : `Check the Python environment and its ${recovery.moduleName} installation.`}{" "}
                            Changing the default does not switch an existing session.
                          </p>
                          <Button
                            size="xs"
                            variant="ghost-muted"
                            className="mt-1"
                            render={
                              <Link
                                to="/settings/scientific-computing"
                                search={{ environmentId: props.environmentId }}
                              />
                            }
                          >
                            Choose Python environment…
                          </Button>
                        </div>
                      ) : null}
                      <ComputeDiagnosticFrames
                        frames={output.diagnostic.frames}
                        threadRef={props.threadRef}
                      />
                      {output.diagnostic.traceback.length > 0 ? (
                        <details className="mt-1 text-muted-foreground">
                          <summary className="cursor-pointer">Traceback</summary>
                          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
                            {output.diagnostic.traceback.join("\n")}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            }
            case "image": {
              const presentation = computeFigurePresentation({
                allowFollowing: props.allowFigureFollowing ?? false,
                cwd: props.cwd,
                session: props.session,
                executionId: props.executionId,
                ...(props.executionGeneration === undefined
                  ? {}
                  : { executionGeneration: props.executionGeneration }),
                output,
                displayOrdinal,
                runtimeDisplayOrdinal,
                source: props.source ?? null,
              });
              return (
                <ComputeFigure
                  key={outputKey(output, index)}
                  presentation={presentation}
                  environmentId={props.environmentId}
                  observedProjectFile={output.origin?._tag === "project-file"}
                  threadRef={props.threadRef}
                />
              );
            }
            case "system":
              return (
                <div
                  key={outputKey(output, index)}
                  className="flex items-start gap-2 text-[11px] text-muted-foreground"
                >
                  <Info className="mt-0.5 size-3 shrink-0" />
                  <span>
                    {computeSystemEventLabel(output.event)}
                    {output.detail ? ` · ${output.detail}` : ""}
                  </span>
                </div>
              );
            case "representation": {
              const rich = computeRichRepresentation(output);
              if (rich !== null)
                return <ComputeRichOutput key={outputKey(output, index)} representation={rich} />;
              const image = computeProjectedStaticImage(output);
              if (image === null) {
                return (
                  <ComputeRepresentationFallback key={outputKey(output, index)} output={output} />
                );
              }
              return (
                <ComputeFigure
                  key={outputKey(output, index)}
                  presentation={computeFigurePresentation({
                    allowFollowing: props.allowFigureFollowing ?? false,
                    cwd: props.cwd,
                    session: props.session,
                    executionId: props.executionId,
                    ...(props.executionGeneration === undefined
                      ? {}
                      : { executionGeneration: props.executionGeneration }),
                    output: image,
                    displayOrdinal,
                    runtimeDisplayOrdinal,
                    source: props.source ?? null,
                  })}
                  environmentId={props.environmentId}
                  observedProjectFile={false}
                  threadRef={props.threadRef}
                />
              );
            }
          }
        },
      )}
    </div>
  );
}
