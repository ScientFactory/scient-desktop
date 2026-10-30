import type {
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeRuntimeInspection,
  ComputeSessionRecord,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { CircleAlert, Info } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { useRightPanelStore } from "~/rightPanelStore";

import { computeFigurePresentation } from "./computeFigurePresentation";
import { ComputeFigure } from "./ComputeFigure";
import { computeOutputBlocks, type ComputeOutputBlock as Block } from "./computeOutputBlocks";
import { ComputeOutputBlock } from "./ComputeOutputBlock";
import {
  computeSystemEventLabel,
  type ComputeStaticImageOutput,
} from "./computeResultPresentation";
import { computeDisplays, type ComputeDisplay } from "./computeRichRepresentation";
import { ComputeRichOutput, type ComputeRichDisplay } from "./ComputeRichOutput";
import { renderTerminalText } from "./computeTerminalText";
import { ComputeTerminalOutput } from "./ComputeTerminalOutput";
import { computeDependencyRecovery, managedDependencyRuntime } from "./computeDependencyRecovery";
import { ComputeDependencyRecoveryAction } from "./ComputeDependencyRecoveryAction";
import type { ComputeContextId } from "./computeContextStore";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];
type ComputeDiagnosticOutput = Extract<ComputeOutput, { readonly _tag: "diagnostic" }>;
type DiagnosticFrame = ComputeDiagnosticOutput["diagnostic"]["frames"][number];

type ProjectedBlock =
  | { readonly kind: "stream"; readonly block: Extract<Block, { readonly kind: "stream" }> }
  | {
      readonly kind: "figure";
      readonly key: string;
      readonly image: ComputeStaticImageOutput;
      readonly displayOrdinal: number;
      readonly runtimeDisplayOrdinal: number;
    }
  | {
      readonly kind: "rich";
      readonly key: string;
      readonly displays: ReadonlyArray<ComputeRichDisplay>;
    }
  | { readonly kind: "diagnostic"; readonly key: string; readonly output: ComputeDiagnosticOutput }
  | {
      readonly kind: "system";
      readonly key: string;
      readonly output: Extract<ComputeOutput, { readonly _tag: "system" }>;
    };

function isRichDisplay(display: ComputeDisplay): display is ComputeRichDisplay {
  return display.kind !== "image";
}

/** Figure ordinals count what is shown, matching the viewer's figure references. */
function projectBlocks(outputs: ReadonlyArray<ComputeOutput>): ReadonlyArray<ProjectedBlock> {
  let displayOrdinal = 0;
  let runtimeDisplayOrdinal = 0;
  return computeOutputBlocks(outputs).flatMap((block): ProjectedBlock[] => {
    if (block.kind === "stream") return [{ kind: "stream", block }];
    const { output, key } = block;
    switch (output._tag) {
      case "image":
        displayOrdinal += 1;
        if (output.origin?._tag === "runtime-display") runtimeDisplayOrdinal += 1;
        return [
          {
            kind: "figure",
            key,
            image: output,
            displayOrdinal,
            runtimeDisplayOrdinal,
          },
        ];
      case "representation": {
        const displays = computeDisplays(output);
        const preferred = displays[0];
        if (preferred?.kind === "image") {
          displayOrdinal += 1;
          runtimeDisplayOrdinal += 1;
          return [
            {
              kind: "figure",
              key,
              image: preferred.image,
              displayOrdinal,
              runtimeDisplayOrdinal,
            },
          ];
        }
        const rich = displays.filter(isRichDisplay);
        if (rich.length > 0) return [{ kind: "rich", key, displays: rich }];
        return [];
      }
      case "diagnostic":
        return [{ kind: "diagnostic", key, output }];
      case "system":
        return [{ kind: "system", key, output }];
    }
  });
}

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

function ComputeDiagnostic(props: {
  readonly output: ComputeDiagnosticOutput;
  readonly environmentId: EnvironmentId;
  readonly session: ComputeSessionRecord;
  readonly threadRef: ScopedThreadRef;
  readonly runtimeInspection: ComputeRuntimeInspection | null;
  readonly dependencyRecovery?: {
    readonly contextId: ComputeContextId;
    readonly onSettled: () => void;
  };
}) {
  const { diagnostic } = props.output;
  const recovery = computeDependencyRecovery({
    diagnostic,
    session: props.session,
    inspection: props.runtimeInspection,
  });
  const managed =
    recovery === null
      ? null
      : managedDependencyRuntime({
          moduleName: recovery.moduleName,
          session: props.session,
          inspection: props.runtimeInspection,
        });
  const summary = `${diagnostic.errorName}: ${diagnostic.message}`;
  return (
    <ComputeOutputBlock copy={() => ({ text: [summary, ...diagnostic.traceback].join("\n") })}>
      <div className="rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-medium break-words text-destructive">{summary}</p>
            {recovery !== null ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {managed !== null && props.dependencyRecovery !== undefined ? (
                  <ComputeDependencyRecoveryAction
                    contextId={props.dependencyRecovery.contextId}
                    session={props.session}
                    moduleName={recovery.moduleName}
                    executable={managed.executable}
                    onSettled={props.dependencyRecovery.onSettled}
                  />
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    render={
                      <Link
                        to="/settings/scientific-computing"
                        search={{ environmentId: props.environmentId }}
                      />
                    }
                  >
                    Python settings
                  </Button>
                )}
              </div>
            ) : null}
            <ComputeDiagnosticFrames frames={diagnostic.frames} threadRef={props.threadRef} />
            {diagnostic.traceback.length > 0 ? (
              <details className="mt-1 text-muted-foreground">
                <summary className="cursor-pointer">Traceback</summary>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
                  {diagnostic.traceback.join("\n")}
                </pre>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </ComputeOutputBlock>
  );
}

function ComputeStream(props: { readonly block: Extract<Block, { readonly kind: "stream" }> }) {
  const terminal = renderTerminalText(props.block.text);
  if (terminal.text.trim().length === 0) return null;
  return (
    <ComputeOutputBlock tail copy={() => ({ text: terminal.text })}>
      <ComputeTerminalOutput terminal={terminal} stream={props.block.stream} />
    </ComputeOutputBlock>
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
  readonly corruptLineCount?: number;
  readonly clipped?: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly source?: ComputeExecutionSource | null;
  readonly runtimeInspection?: ComputeRuntimeInspection | null;
  readonly dependencyRecovery?: {
    readonly contextId: ComputeContextId;
    readonly onSettled: () => void;
  };
}) {
  const blocks = projectBlocks(props.outputs);
  if (blocks.length === 0 && !props.corruptLineCount && !props.clipped) return null;

  return (
    <div className="space-y-2">
      {props.clipped ? (
        <p className="text-[11px] text-muted-foreground">Earlier output hidden</p>
      ) : null}
      {props.corruptLineCount ? (
        <p className="text-[11px] text-destructive">Some output couldn&apos;t be read</p>
      ) : null}
      {blocks.map((block) => {
        switch (block.kind) {
          case "stream":
            return <ComputeStream key={block.block.key} block={block.block} />;
          case "rich":
            return <ComputeRichOutput key={block.key} displays={block.displays} />;
          case "diagnostic":
            return (
              <ComputeDiagnostic
                key={block.key}
                output={block.output}
                environmentId={props.environmentId}
                session={props.session}
                threadRef={props.threadRef}
                runtimeInspection={props.runtimeInspection ?? null}
                {...(props.dependencyRecovery === undefined
                  ? {}
                  : { dependencyRecovery: props.dependencyRecovery })}
              />
            );
          case "figure":
            return (
              <ComputeFigure
                key={block.key}
                presentation={computeFigurePresentation({
                  allowFollowing: props.allowFigureFollowing ?? false,
                  cwd: props.cwd,
                  session: props.session,
                  executionId: props.executionId,
                  ...(props.executionGeneration === undefined
                    ? {}
                    : { executionGeneration: props.executionGeneration }),
                  output: block.image,
                  displayOrdinal: block.displayOrdinal,
                  runtimeDisplayOrdinal: block.runtimeDisplayOrdinal,
                  source: props.source ?? null,
                })}
                environmentId={props.environmentId}
                cwd={props.cwd}
                threadRef={props.threadRef}
              />
            );
          case "system":
            return (
              <div
                key={block.key}
                className="flex items-start gap-2 text-[11px] text-muted-foreground"
              >
                <Info className="mt-0.5 size-3 shrink-0" />
                <span>
                  {computeSystemEventLabel(block.output.event)}
                  {block.output.detail ? ` · ${block.output.detail}` : ""}
                </span>
              </div>
            );
        }
      })}
    </div>
  );
}
