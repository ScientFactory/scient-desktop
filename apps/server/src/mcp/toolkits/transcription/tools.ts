import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { consumeAgentWorkspace } from "../../../scient/operations/AgentWorkspaceScope.ts";
import { AgentInvocationContext } from "../../../scient/operations/AgentInvocationContext.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import {
  RevisionId,
  StartRequest,
  TranscriptionError,
  TranscriptionJobs,
  type Status,
} from "../../../transcription/TranscriptionJobs.ts";
import { EngineInventory, InventoryInput } from "../../../transcription/engineInventory.ts";
import { ScientOperation } from "../../ScientOperationTool.ts";

const dependencies = [AgentInvocationContext, WorkspaceBindingResolver, TranscriptionJobs];
const schemas = { failure: TranscriptionError, dependencies };
const waitSeconds = Schema.optionalKey(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
);
const operation = (id: string) =>
  ({
    id: "transcription." + id,
    scope: "workspace",
    requiredCapabilities: ["transcription"],
  }) as const;

const JobSummary = Schema.Struct({
  id: RevisionId,
  stage: Schema.Literals([
    "decoding",
    "writing",
    "transcribing",
    "completed",
    "canceled",
    "interrupted",
    "failed",
    "paused",
  ]),
  committedWindows: Schema.Int,
  totalWindows: Schema.optionalKey(Schema.Int),
  errorCode: Schema.optionalKey(Schema.String),
  outputs: Schema.optionalKey(Schema.Struct({ json: Schema.String, markdown: Schema.String })),
});

const engines = Tool.make("scient_transcription_engines", {
  ...schemas,
  success: EngineInventory,
  description:
    "List transcription engines, installed and installable models, and language recommendations.",
  parameters: InventoryInput,
})
  .annotate(Tool.Readonly, true)
  .annotate(ScientOperation, operation("engines"));

const start = Tool.make("scient_transcription_start", {
  ...schemas,
  success: JobSummary,
  description:
    "Transcribe an audio file in this project. Defaults to an installed local model and automatic language detection. Range times are seconds in the source. A job continues after waitSeconds expires (default 0).",
  parameters: Schema.Struct({
    source: StartRequest.fields.source,
    engine: Schema.optionalKey(StartRequest.fields.engine),
    model: Schema.optionalKey(StartRequest.fields.model),
    cloudEngineId: StartRequest.fields.cloudEngineId,
    mode: StartRequest.fields.mode,
    language: Schema.optionalKey(StartRequest.fields.language),
    rule: StartRequest.fields.rule,
    range: StartRequest.fields.range,
    resume: StartRequest.fields.resume,
    providerInstanceId: StartRequest.fields.providerInstanceId,
    waitSeconds,
  }),
}).annotate(ScientOperation, operation("start"));

const status = Tool.make("scient_transcription_status", {
  ...schemas,
  success: JobSummary,
  description:
    "Read a transcription job's progress and transcript paths. Optionally wait up to 30 seconds.",
  parameters: Schema.Struct({ id: RevisionId, waitSeconds }),
})
  .annotate(Tool.Readonly, true)
  .annotate(ScientOperation, operation("status"));

const cancel = Tool.make("scient_transcription_cancel", {
  ...schemas,
  success: JobSummary,
  description: "Cancel a transcription job in this project and keep its committed windows.",
  parameters: Schema.Struct({ id: RevisionId }),
}).annotate(ScientOperation, operation("cancel"));

const list = Tool.make("scient_transcription_list", {
  ...schemas,
  success: Schema.Struct({ jobs: Schema.Array(JobSummary) }),
  description: "List transcription jobs in this project.",
  parameters: Schema.Record(Schema.String, Schema.Never),
})
  .annotate(Tool.Readonly, true)
  .annotate(ScientOperation, operation("list"));

export const ScientTranscriptionToolkit = Toolkit.make(engines, start, status, cancel, list);

const projectRoot = Effect.fn("ScientTranscriptionToolkit.projectRoot")(function* () {
  const workspace = yield* consumeAgentWorkspace().pipe(
    Effect.mapError(
      (error) => new TranscriptionError({ code: "invalid-input", detail: error.message }),
    ),
  );
  return workspace.binding.canonicalRoot;
});

const errorCodes = new Set([
  "signed-out",
  "provider-credentials",
  "cloud-upload-disabled",
  "decode-failed",
  "write-failed",
  "recognition-failed",
]);
const summarize = ({ job, state }: Status): typeof JobSummary.Type => {
  const errorCode =
    state.stage === "paused"
      ? "rate-limited"
      : state.stage === "failed" && state.error && errorCodes.has(state.error.code)
        ? state.error.code
        : undefined;
  return {
    id: job.id,
    stage: state.stage,
    committedWindows: state.completed,
    ...("total" in state && state.total !== undefined ? { totalWindows: state.total } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(state.stage === "completed" || state.completed > 0
      ? {
          outputs: {
            json: `Transcripts/${job.id}/transcript.json`,
            markdown: `Transcripts/${job.id}/transcript.md`,
          },
        }
      : {}),
  };
};

const summarizeJob = (result: object) => {
  if (!("job" in result)) throw new Error("Expected one transcription job.");
  return summarize(result as Status);
};

export const ScientTranscriptionToolkitHandlersLive = ScientTranscriptionToolkit.toLayer({
  scient_transcription_engines: Effect.fn("ScientTranscriptionToolkit.engines")(function* (input) {
    const project = yield* projectRoot();
    return yield* (yield* TranscriptionJobs).engines(project, input);
  }),
  scient_transcription_start: Effect.fn("ScientTranscriptionToolkit.start")(function* ({
    waitSeconds,
    ...input
  }) {
    const project = yield* projectRoot();
    const jobs = yield* TranscriptionJobs;
    const { threadId } = yield* AgentInvocationContext;
    return summarizeJob(yield* jobs.startScoped(project, input, waitSeconds ?? 0, threadId));
  }),
  scient_transcription_status: Effect.fn("ScientTranscriptionToolkit.status")(function* ({
    id,
    waitSeconds,
  }) {
    const project = yield* projectRoot();
    return summarizeJob(
      yield* (yield* TranscriptionJobs).execute(
        { action: "status", project, id },
        { scoped: true, waitSeconds: waitSeconds ?? 0 },
      ),
    );
  }),
  scient_transcription_cancel: Effect.fn("ScientTranscriptionToolkit.cancel")(function* ({ id }) {
    const project = yield* projectRoot();
    return summarizeJob(
      yield* (yield* TranscriptionJobs).execute(
        { action: "cancel", project, id },
        { scoped: true },
      ),
    );
  }),
  scient_transcription_list: Effect.fn("ScientTranscriptionToolkit.list")(function* () {
    const project = yield* projectRoot();
    const result = yield* (yield* TranscriptionJobs).execute(
      { action: "list", project },
      { scoped: true },
    );
    if (!Array.isArray(result)) throw new Error("Expected a list of transcription jobs.");
    return { jobs: result.filter((item): item is Status => "job" in item).map(summarize) };
  }),
});
