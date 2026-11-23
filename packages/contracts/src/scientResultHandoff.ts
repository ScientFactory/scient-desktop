import * as Schema from "effect/Schema";

import {
  ComputeResultOutput,
  ComputeResultParameter,
  ComputeResultRevisionId,
  ComputeResultSourceKind,
} from "./scientComputeResults.ts";

const Text = Schema.String.check(Schema.isMaxLength(4096));
const Path = Text.check(Schema.isNonEmpty());
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const OperationId = Schema.String.check(Schema.isUUID());
const Size = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ResultHandoffInputFile = Schema.Struct({
  path: Path,
  origin: Schema.Literals(["observed", "declared", "both"]),
  via: Schema.optional(Path),
  size: Size,
  /** Run-time digest in new packages. */
  sha256: Schema.NullOr(Sha256),
  changedDuringRun: Schema.Boolean,
  /** The file checked at export, whether packaged or supplied separately. */
  exportFile: Schema.optional(Schema.Struct({ size: Size, sha256: Sha256 })),
  changedSinceRun: Schema.optional(Schema.Boolean),
  /** Legacy packages used sha256 for the export-time digest in this case. */
  hashAtExport: Schema.optional(Schema.Boolean),
});
export type ResultHandoffInputFile = typeof ResultHandoffInputFile.Type;

const InputCoverage = Schema.Struct({
  tracking: Schema.Literals(["observed", "not-tracked"]),
  truncated: Schema.Boolean,
  readsOutsideProject: Schema.NullOr(Size),
  unresolvedViewInputs: Size,
});

export const ResultHandoffManifest = Schema.Struct({
  version: Schema.Literals([1, 2]),
  revision: ComputeResultRevisionId,
  createdAt: Text,
  scientVersion: Text,
  run: Schema.Struct({ startedAt: Schema.NullOr(Text), finishedAt: Text }),
  source: Schema.Struct({
    path: Path,
    kind: ComputeResultSourceKind,
    language: Text,
    sha256: Sha256,
    notebookDigestVersion: Schema.optional(Schema.Literal(1)),
    fileSha256: Sha256,
    size: Size,
  }),
  code: Schema.optional(Schema.Array(Schema.Struct({ path: Path, sha256: Sha256, size: Size }))),
  runtime: Schema.Struct({ version: Schema.NullOr(Text) }),
  parameters: Schema.optional(Schema.Array(ComputeResultParameter).check(Schema.isMaxLength(200))),
  inputs: Schema.Array(
    Schema.Struct({ ...ResultHandoffInputFile.fields, included: Schema.Boolean }),
  ),
  documentation: Schema.Struct({ readmeSha256: Sha256, crateSha256: Sha256 }),
  inputTracking: Schema.Literals(["observed", "not-tracked"]),
  inputsTruncated: Schema.Boolean,
  inputCoverage: Schema.optional(InputCoverage),
  outputs: Schema.Array(ComputeResultOutput),
  outputsOmitted: Size,
  skippedOutputs: Schema.optional(Schema.Array(Path)),
  license: Schema.optional(Schema.Struct({ sha256: Sha256, size: Size })),
  environment: Schema.Struct({
    lockfiles: Schema.Array(
      Schema.Struct({
        path: Path,
        sha256: Sha256,
        included: Schema.Boolean,
        fileSha256: Schema.optional(Sha256),
        prefixRemoved: Schema.optional(Schema.Boolean),
        excludedReason: Schema.optional(
          Schema.Literals(["private-path", "unavailable", "selected"]),
        ),
      }),
    ),
    omittedRuntimeInputs: Schema.optional(Size),
    packageListSha256: Schema.optional(Sha256),
    packagesTruncated: Schema.optional(Schema.Boolean),
  }),
});
export type ResultHandoffManifest = typeof ResultHandoffManifest.Type;

export const ResultHandoffRevisionInput = Schema.Struct({
  cwd: Path,
  revision: ComputeResultRevisionId,
});
export type ResultHandoffRevisionInput = typeof ResultHandoffRevisionInput.Type;

export const ResultHandoffChoices = Schema.Struct({
  code: Schema.optional(Schema.Array(Path)),
  inputs: Schema.Array(
    Schema.Struct({
      ...ResultHandoffInputFile.fields,
      copyAvailable: Schema.optional(Schema.Boolean),
    }),
  ),
  lockfiles: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Path,
        status: Schema.Literals(["ready", "prefix-removed", "private-path", "unavailable"]),
        size: Schema.optional(Size),
      }),
    ),
  ),
});

export type ResultHandoffChoices = typeof ResultHandoffChoices.Type;

export const ResultHandoffExportInput = Schema.Struct({
  ...ResultHandoffRevisionInput.fields,
  destination: Path,
  includeInputs: Schema.Array(Path).check(Schema.isMaxLength(4096)),
  progressId: Schema.optional(OperationId),
  excludeLockfiles: Schema.optional(Schema.Array(Path).check(Schema.isMaxLength(4096))),
});
export type ResultHandoffExportInput = typeof ResultHandoffExportInput.Type;

export const ResultHandoffExportResult = Schema.Struct({
  folder: Path,
  warnings: Schema.optional(Schema.Array(Text)),
});

export const ResultHandoffExportProgressInput = Schema.Struct({ progressId: OperationId });
export const ResultHandoffExportProgress = Schema.NullOr(
  Schema.Struct({
    filesHashed: Size,
    totalFiles: Size,
    bytesHashed: Size,
  }),
);
export type ResultHandoffExportProgress = NonNullable<typeof ResultHandoffExportProgress.Type>;

export const ResultHandoffVerifyInput = Schema.Struct({
  packageFolder: Path,
  inputsFolder: Schema.optional(Path),
  executable: Schema.optional(Path),
  absoluteTolerance: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  relativeTolerance: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  verifierName: Schema.optional(Text.check(Schema.isMaxLength(200))),
  timeoutMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  allowExecution: Schema.Literal(true),
});
export type ResultHandoffVerifyInput = typeof ResultHandoffVerifyInput.Type;

export const ResultHandoffVerifyRequest = Schema.Struct({
  ...ResultHandoffVerifyInput.fields,
  verificationId: Schema.optional(OperationId),
});
export type ResultHandoffVerifyRequest = typeof ResultHandoffVerifyRequest.Type;
export const ResultHandoffCancelInput = Schema.Struct({ verificationId: OperationId });
export const ResultHandoffCancelResult = Schema.Struct({ requested: Schema.Boolean });

const ResultHandoffFinding = Schema.Struct({
  path: Path,
  status: Schema.Literals(["matched", "differs", "missing", "unchecked", "unlisted"]),
  message: Schema.optional(Text),
  separatelySupplied: Schema.optional(Schema.Literal(true)),
});
export type ResultHandoffFinding = typeof ResultHandoffFinding.Type;

const ResultHandoffValueDifference = Schema.Struct({
  pointer: Text,
  expected: Schema.optional(Text),
  actual: Schema.optional(Text),
  absoluteDifference: Schema.optional(Schema.Number.check(Schema.isFinite())),
  relativeDifference: Schema.optional(Schema.Number.check(Schema.isFinite())),
});
export type ResultHandoffValueDifference = typeof ResultHandoffValueDifference.Type;

const WorstError = Schema.Struct({ pointer: Text, error: Schema.Number.check(Schema.isFinite()) });

export const ResultHandoffOutputFinding = Schema.Struct({
  ...ResultHandoffFinding.fields,
  sha256: Schema.optional(Sha256),
  differenceCount: Schema.optional(Size),
  maxAbsoluteError: Schema.optional(WorstError),
  maxRelativeError: Schema.optional(WorstError),
  values: Schema.optional(Schema.Array(ResultHandoffValueDifference)),
});
export type ResultHandoffOutputFinding = typeof ResultHandoffOutputFinding.Type;

export const ResultHandoffVerification = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.NullOr(ComputeResultRevisionId),
  verifiedAt: Text,
  verifierName: Schema.optional(Text),
  status: Schema.Literals([
    "verified",
    "outputs-matched-inputs-unconfirmed",
    "differs",
    "could-not-run",
    "cancelled",
  ]),
  verdict: Schema.optional(Text),
  inputCoverage: Schema.optional(InputCoverage),
  /** The rerun completed even when no retained output can establish a verdict. */
  rerunCompleted: Schema.optional(Schema.Boolean),
  message: Schema.optional(Text),
  absoluteTolerance: Schema.Number,
  relativeTolerance: Schema.Number,
  timeoutMinutes: Schema.optional(Schema.Int),
  environment: Schema.NullOr(
    Schema.Struct({
      language: Text,
      version: Schema.NullOr(Text),
      platform: Text,
      architecture: Text,
      locale: Text,
      timezone: Text,
      packages: Schema.optional(Schema.Array(Schema.Struct({ name: Text, version: Text }))),
    }),
  ),
  environmentChanges: Schema.Array(
    Schema.Struct({ name: Text, recorded: Schema.NullOr(Text), rerun: Schema.NullOr(Text) }),
  ),
  files: Schema.Array(ResultHandoffFinding),
  outputs: Schema.Array(ResultHandoffOutputFinding),
});
export type ResultHandoffVerification = typeof ResultHandoffVerification.Type;

export function resultHandoffOutcome(
  report: Pick<
    ResultHandoffVerification,
    "status" | "rerunCompleted" | "message" | "environment" | "outputs"
  >,
) {
  const review = report.outputs.some(
    (output) => output.status === "differs" || output.status === "missing",
  );
  switch (report.status) {
    case "outputs-matched-inputs-unconfirmed":
      return { label: "Outputs matched · original inputs unconfirmed", completed: true } as const;
    case "verified": {
      const unchecked = report.outputs.some((output) => output.status === "unchecked");
      return {
        label: review
          ? unchecked
            ? "Checked outputs matched · review figures and unchecked outputs"
            : "Checked outputs matched · figures need review"
          : unchecked || report.message !== undefined
            ? "Checked outputs matched · some outputs unchecked"
            : "Verified",
        completed: true,
      } as const;
    }
    case "differs":
      return { label: "Differs", completed: false } as const;
    case "cancelled":
      return { label: "Cancelled", completed: false } as const;
    case "could-not-run": {
      const matched = report.outputs.some((output) => output.status === "matched");
      const completed =
        report.rerunCompleted ??
        (report.environment !== null &&
          (review || matched || report.message?.startsWith("The rerun finished") === true));
      return {
        label: completed
          ? review
            ? "Rerun finished · figures need review"
            : matched
              ? "Rerun finished · figures matched"
              : "Rerun finished · no checkable outputs"
          : "Could not run",
        completed,
      } as const;
    }
  }
}

export const ResultHandoffVerifyResult = Schema.Struct({
  report: ResultHandoffVerification,
  reportPath: Path,
  figures: Schema.Array(
    Schema.Struct({
      name: Path,
      mediaType: Text,
      originalPath: Path,
      rerunPath: Path,
      originalPreview: Schema.optional(Schema.String),
      rerunPreview: Schema.optional(Schema.String),
    }),
  ),
});
export type ResultHandoffVerifyResult = typeof ResultHandoffVerifyResult.Type;
