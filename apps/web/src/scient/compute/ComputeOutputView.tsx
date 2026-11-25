import type {
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeRuntimeInspection,
  ComputeSessionRecord,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { CircleAlert, Info } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { useRightPanelStore } from "~/rightPanelStore";

import { computeFigurePresentation } from "./computeFigurePresentation";
import { ComputeFigure } from "./ComputeFigure";
import { computeOutputBlocks, type ComputeOutputBlock as Block } from "./computeOutputBlocks";
import { ComputeOutputBlock } from "./ComputeOutputBlock";
import {
  computeDiagnosticSummary,
  computeSystemEventLabel,
  type ComputeStaticImageOutput,
} from "./computeResultPresentation";
import { computeDisplays, type ComputeDisplay } from "./computeRichRepresentation";
import { ComputeRichOutput, type ComputeRichDisplay } from "./ComputeRichOutput";
import { renderTerminalText } from "./computeTerminalText";
import { ComputeTerminalOutput } from "./ComputeTerminalOutput";
import { computeDependencyRecovery, managedDependencyRuntime } from "./computeDependencyRecovery";
import {
  ComputeAddPackageAction,
  ComputeDependencyRecoveryAction,
  type ComputeDependencyRecoveryPlace,
} from "./ComputeDependencyRecoveryAction";

import type { NotebookDefiningCell } from "../notebook/notebookRunSummary";
import { extractUndefinedName } from "../notebook/notebookRunSummary";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];

type ComputeDiagnosticOutput = Extract<ComputeOutput, { readonly _tag: "diagnostic" }>;
type DiagnosticFrame = ComputeDiagnosticOutput["diagnostic"]["frames"][number];

interface NotebookDiagnosticContext {
  readonly path: string;
  readonly onReplay?: (() => void) | undefined;
  readonly onJumpToCell?: ((cellId: string) => void) | undefined;
  readonly definingCell?: ((name: string) => NotebookDefiningCell | null) | undefined;
}

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
  readonly notebookPath?: string | undefined;
}) {
  const gt = useGT();
  if (props.frames.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {props.frames.slice(-6).map((frame) => {
        const key = `${frame.relativePath}:${String(frame.line)}:${String(frame.column)}:${frame.functionName ?? ""}`;
        if (frame.relativePath === props.notebookPath) {
          return frame.line === null ? null : (
            <span key={key} className="text-[11px] text-muted-foreground">
              {gt("Line {line} in a notebook cell", { line: frame.line })}
              {frame.functionName === null ? "" : ` · ${frame.functionName}`}
            </span>
          );
        }
        return (
          <button
            key={key}
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
        );
      })}
    </div>
  );
}

export function NotebookSetupRecovery(props: {
  readonly errorName: unknown;
  readonly message: unknown;
  readonly onReplay: (() => void) | undefined;
  readonly onJumpToCell?: ((cellId: string) => void) | undefined;
  readonly definingCell?: NotebookDefiningCell | null | undefined;
}) {
  const gt = useGT();
  const missingName = extractUndefinedName(props.errorName, props.message);
  if (missingName === null) return null;
  const defining = props.definingCell ?? null;
  if (defining?.status === "failed" && props.onJumpToCell !== undefined) {
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <p>
          {gt("Cell {cell} defines {name} and failed.", {
            cell: defining.cellNumber,
            name: missingName,
          })}
        </p>
        <Button
          size="xs"
          variant="outline"
          focus="edge"
          onClick={() => props.onJumpToCell?.(defining.cellId)}
        >
          {gt("Jump to cell {cell}", { cell: defining.cellNumber })}
        </Button>
      </div>
    );
  }
  // Replay only helps when an earlier cell defines the name and has not run in this session.
  if (props.onReplay === undefined || defining?.status !== "not-run") return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <p>
        {gt("Cell {cell} defines {name} and has not run in this session.", {
          cell: defining.cellNumber,
          name: missingName,
        })}
      </p>
      <Button size="xs" variant="outline" focus="edge" onClick={props.onReplay}>
        <T>Run from top through this cell</T>
      </Button>
    </div>
  );
}

function ComputeDiagnostic(props: {
  readonly output: ComputeDiagnosticOutput;
  readonly environmentId: EnvironmentId;
  readonly session: ComputeSessionRecord;
  readonly threadRef: ScopedThreadRef;
  readonly runtimeInspection: ComputeRuntimeInspection | null;
  readonly dependencyRecovery?: ComputeDependencyRecoveryPlace;
  readonly onAskAgent?: ((text: string) => void) | undefined;
  readonly notebook?: NotebookDiagnosticContext | undefined;
}) {
  const { diagnostic } = props.output;
  const recovery = props.dependencyRecovery?.resolved
    ? null
    : computeDependencyRecovery({
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
  const canAddPackages =
    props.runtimeInspection?.languages
      .find((language) => language.descriptor.languageId === props.session.languageId)
      ?.descriptor.capabilities.includes("packages") === true;
  const { summary, traceback } = computeDiagnosticSummary(diagnostic);
  const fullText = [summary, traceback].filter(Boolean).join("\n");
  const missingName = extractUndefinedName(diagnostic.errorName, diagnostic.message);
  const definingCell =
    missingName === null ? null : (props.notebook?.definingCell?.(missingName) ?? null);
  return (
    <ComputeOutputBlock copy={() => ({ text: fullText })}>
      <div className="rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs">
        <div className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 font-medium break-words text-destructive">{summary}</p>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {recovery !== null && props.dependencyRecovery !== undefined && canAddPackages ? (
                  <ComputeAddPackageAction
                    contextId={props.dependencyRecovery.contextId}
                    sessionId={props.session.sessionId}
                    distribution={recovery.distribution}
                    runAgain={props.dependencyRecovery.runAgain}
                  />
                ) : null}
                {recovery === null ? null : managed !== null &&
                  props.dependencyRecovery !== undefined ? (
                  <ComputeDependencyRecoveryAction
                    contextId={props.dependencyRecovery.contextId}
                    session={props.session}
                    moduleName={recovery.moduleName}
                    executable={managed.executable}
                    onSettled={props.dependencyRecovery.onSettled}
                  />
                ) : props.dependencyRecovery !== undefined ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    render={
                      <Link
                        to="/settings/scientific-computing/$languageId"
                        params={{ languageId: "python" }}
                        search={{ environmentId: props.environmentId }}
                      />
                    }
                  >
                    <T>Python settings</T>
                  </Button>
                )}
                {props.onAskAgent === undefined ? null : (
                  <Button size="xs" variant="outline" onClick={() => props.onAskAgent?.(fullText)}>
                    <T>Ask agent</T>
                  </Button>
                )}
              </div>
            </div>
            <ComputeDiagnosticFrames
              frames={diagnostic.frames}
              threadRef={props.threadRef}
              notebookPath={props.notebook?.path}
            />
            <NotebookSetupRecovery
              errorName={diagnostic.errorName}
              message={diagnostic.message}
              onReplay={props.notebook?.onReplay}
              onJumpToCell={props.notebook?.onJumpToCell}
              definingCell={definingCell}
            />
            {traceback.length > 0 ? (
              <details className="mt-1 text-muted-foreground">
                <summary className="cursor-pointer">
                  <T>Details</T>
                </summary>
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
                  {traceback}
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
  readonly notebook?: NotebookDiagnosticContext | undefined;
  readonly runtimeInspection?: ComputeRuntimeInspection | null;
  /** Puts an error in the chat as a quote of this run. */
  readonly onAskAgent?: ((text: string) => void) | undefined;
  readonly dependencyRecovery?: ComputeDependencyRecoveryPlace;
}) {
  const gt = useGT();
  const messages = useMessages();
  const blocks = projectBlocks(props.outputs);
  if (blocks.length === 0 && !props.corruptLineCount && !props.clipped) return null;

  return (
    <div className="space-y-2">
      {props.clipped ? (
        <p className="text-[11px] text-muted-foreground">
          <T>Earlier output hidden</T>
        </p>
      ) : null}
      {props.corruptLineCount ? (
        <p className="text-[11px] text-destructive">
          <T>Some output couldn&apos;t be read</T>
        </p>
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
                onAskAgent={props.onAskAgent}
                notebook={props.notebook}
              />
            );
          case "figure":
            return (
              <ComputeFigure
                key={block.key}
                presentation={computeFigurePresentation(
                  {
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
                  },
                  messages,
                )}
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
                  {block.output.detail
                    ? gt("{event} · {detail}", {
                        event: computeSystemEventLabel(block.output.event, messages),
                        detail: block.output.detail,
                      })
                    : computeSystemEventLabel(block.output.event, messages)}
                </span>
              </div>
            );
        }
      })}
    </div>
  );
}
