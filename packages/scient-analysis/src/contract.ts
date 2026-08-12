import {
  ExecutionOutputChunk,
  ExecutionReceipt,
  ExecutionReceiptSummary,
  ExecutionRunId,
} from "@scientfactory/execution";
import * as Schema from "effect/Schema";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const PathString = Schema.NonEmptyString.check(Schema.isMaxLength(32 * 1024));

export const ANALYSIS_CONTRACT_VERSION = 1 as const;

export const AnalysisRuntimeId = Identifier.pipe(Schema.brand("AnalysisRuntimeId"));
export type AnalysisRuntimeId = typeof AnalysisRuntimeId.Type;

export const AnalysisRuntimeKind = Schema.NonEmptyString.check(Schema.isMaxLength(64));
export type AnalysisRuntimeKind = typeof AnalysisRuntimeKind.Type;

export const AnalysisRuntimeCapability = Schema.Literals([
  "run-file",
  "stream-output",
  "cancel-process-tree",
]);
export type AnalysisRuntimeCapability = typeof AnalysisRuntimeCapability.Type;

export const AnalysisRuntimeAvailability = Schema.Literals([
  "available",
  "missing",
  "invalid",
  "unchecked",
]);
export type AnalysisRuntimeAvailability = typeof AnalysisRuntimeAvailability.Type;

export const AnalysisRuntimeSource = Schema.Literals([
  "custom",
  "path",
  "conventional-install",
  "unconfigured",
]);
export type AnalysisRuntimeSource = typeof AnalysisRuntimeSource.Type;

export const AnalysisRuntimeProfile = Schema.Struct({
  id: AnalysisRuntimeId,
  kind: AnalysisRuntimeKind,
  label: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  availability: AnalysisRuntimeAvailability,
  source: AnalysisRuntimeSource,
  executablePath: Schema.NullOr(PathString),
  version: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2048))),
  capabilities: Schema.Array(AnalysisRuntimeCapability),
  inspectedAt: Schema.String,
});
export type AnalysisRuntimeProfile = typeof AnalysisRuntimeProfile.Type;

export const AnalysisRuntimeInspection = Schema.Struct({
  contractVersion: Schema.Literal(ANALYSIS_CONTRACT_VERSION),
  runtimes: Schema.Array(AnalysisRuntimeProfile),
});
export type AnalysisRuntimeInspection = typeof AnalysisRuntimeInspection.Type;

export const AnalysisSourceRevision = Schema.NonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("AnalysisSourceRevision"),
);
export type AnalysisSourceRevision = typeof AnalysisSourceRevision.Type;

export const AnalysisRunSource = Schema.Struct({
  cwd: PathString,
  relativePath: PathString,
  revision: AnalysisSourceRevision,
});
export type AnalysisRunSource = typeof AnalysisRunSource.Type;

export const AnalysisRunAction = Schema.Literals([
  "run-file",
  "run-selection",
  "run-cell",
  "run-task",
]);
export type AnalysisRunAction = typeof AnalysisRunAction.Type;

const AnalysisRunBase = Schema.Struct({
  contractVersion: Schema.Literal(ANALYSIS_CONTRACT_VERSION),
  projectId: Identifier,
  action: AnalysisRunAction,
  runtime: AnalysisRuntimeProfile,
  source: AnalysisRunSource,
});

export const AnalysisRunSummary = Schema.Struct({
  ...AnalysisRunBase.fields,
  receipt: ExecutionReceiptSummary,
});
export type AnalysisRunSummary = typeof AnalysisRunSummary.Type;

export const AnalysisRunSnapshot = Schema.Struct({
  ...AnalysisRunBase.fields,
  receipt: ExecutionReceipt,
});
export type AnalysisRunSnapshot = typeof AnalysisRunSnapshot.Type;

export const AnalysisInspectRuntimesInput = Schema.Struct({
  cwd: PathString,
  refresh: Schema.optional(Schema.Boolean),
});
export type AnalysisInspectRuntimesInput = typeof AnalysisInspectRuntimesInput.Type;

export const AnalysisConfigureRuntimeInput = Schema.Struct({
  cwd: PathString,
  runtimeKind: AnalysisRuntimeKind,
  executablePath: Schema.NullOr(PathString),
});
export type AnalysisConfigureRuntimeInput = typeof AnalysisConfigureRuntimeInput.Type;

export const AnalysisStartRunInput = Schema.Struct({
  cwd: PathString,
  relativePath: PathString,
  sourceRevision: AnalysisSourceRevision,
  runtimeId: AnalysisRuntimeId,
});
export type AnalysisStartRunInput = typeof AnalysisStartRunInput.Type;

export const AnalysisCancelRunInput = Schema.Struct({
  cwd: PathString,
  runId: ExecutionRunId,
});
export type AnalysisCancelRunInput = typeof AnalysisCancelRunInput.Type;

export const AnalysisListRunsInput = Schema.Struct({
  cwd: PathString,
  relativePath: Schema.optional(PathString),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type AnalysisListRunsInput = typeof AnalysisListRunsInput.Type;

export const AnalysisListRunsResult = Schema.Struct({
  runs: Schema.Array(AnalysisRunSummary),
});
export type AnalysisListRunsResult = typeof AnalysisListRunsResult.Type;

export const AnalysisGetRunInput = Schema.Struct({
  cwd: PathString,
  runId: ExecutionRunId,
});
export type AnalysisGetRunInput = typeof AnalysisGetRunInput.Type;

export const AnalysisSubscribeRunsInput = Schema.Struct({
  cwd: PathString,
  relativePath: Schema.optional(PathString),
});
export type AnalysisSubscribeRunsInput = typeof AnalysisSubscribeRunsInput.Type;

export const AnalysisRunStreamEvent = Schema.Union([
  Schema.TaggedStruct("run-snapshot", {
    eventSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    run: AnalysisRunSnapshot,
  }),
  Schema.TaggedStruct("run-updated", {
    eventSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    run: AnalysisRunSummary,
  }),
  Schema.TaggedStruct("run-output", {
    eventSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    projectId: Identifier,
    runId: ExecutionRunId,
    source: AnalysisRunSource,
    chunks: Schema.Array(ExecutionOutputChunk),
    outputTruncated: Schema.Boolean,
    outputByteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
]);
export type AnalysisRunStreamEvent = typeof AnalysisRunStreamEvent.Type;

export function summarizeAnalysisRun(run: AnalysisRunSnapshot): AnalysisRunSummary {
  const { output: _output, ...receipt } = run.receipt;
  return { ...run, receipt };
}

export class AnalysisOperationError extends Schema.TaggedErrorClass<AnalysisOperationError>()(
  "AnalysisOperationError",
  {
    operation: Schema.Literals([
      "inspect",
      "configure",
      "start",
      "cancel",
      "list",
      "get",
      "subscribe",
    ]),
    reason: Schema.Literals([
      "project-not-initialized",
      "invalid-source",
      "source-changed",
      "runtime-missing",
      "runtime-invalid",
      "run-not-found",
      "run-already-finished",
      "run-already-active",
      "persistence-failed",
      "process-failed",
      "operation-failed",
    ]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AnalysisRunContext {
  readonly runId: ExecutionRunId;
  readonly projectId: string;
  readonly runtime: AnalysisRuntimeProfile;
  readonly source: AnalysisRunSource;
  readonly absoluteSourcePath: string;
}

export interface AnalysisRuntimeAdapter {
  readonly id: AnalysisRuntimeId;
  readonly kind: AnalysisRuntimeKind;
  readonly fileExtensions: ReadonlyArray<string>;
  readonly inspect: (input: {
    readonly customExecutablePath?: string;
    readonly inspectedAt: string;
    readonly platform: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }) => Promise<AnalysisRuntimeProfile>;
  readonly prepare: (context: AnalysisRunContext) => {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
  };
}
