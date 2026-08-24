import { type ClaudeSettings, VoiceTranscriptCorrectionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeClaudeEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import {
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeEffort,
} from "../../provider/Layers/ClaudeProvider.ts";
import { toJsonSchemaObject } from "../../textGeneration/TextGenerationUtils.ts";
import type { ProviderVoiceTranscriptCorrection } from "../../provider/ProviderDriver.ts";
import {
  buildVoiceTranscriptCorrectionPrompt,
  validateVoiceTranscriptCorrectionOutput,
  VoiceTranscriptCorrectionOutput,
} from "./VoiceTranscriptCorrectionPrompt.ts";
import { runVoiceTranscriptCorrectionProcess } from "./VoiceTranscriptCorrectionProcess.ts";

const ClaudeOutputEnvelope = Schema.Struct({ structured_output: Schema.Unknown });
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeClaudeOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeOutputEnvelope));
const isVoiceTranscriptCorrectionError = Schema.is(VoiceTranscriptCorrectionError);

export function buildClaudeVoiceTranscriptCorrectionArgs(input: {
  readonly model: string;
  readonly jsonSchema: string;
  readonly effort?: string;
}): ReadonlyArray<string> {
  return [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    input.jsonSchema,
    "--model",
    input.model,
    ...(input.effort ? ["--effort", input.effort] : []),
    "--no-session-persistence",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
  ];
}

export function makeClaudeVoiceTranscriptCorrection(
  settings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  ProviderVoiceTranscriptCorrection,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const providerEnvironment = yield* makeClaudeEnvironment(settings, environment);

    const correct: ProviderVoiceTranscriptCorrection["correct"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "scient-voice-claude-",
          });
          const model = resolveClaudeApiModelId(input.modelSelection);
          const effort = normalizeClaudeCliEffort(
            resolveClaudeEffort(getClaudeModelCapabilities(input.modelSelection.model), "low"),
            input.modelSelection.model,
          );
          const stdout = yield* runVoiceTranscriptCorrectionProcess({
            spawner,
            binaryPath: settings.binaryPath?.trim() || "claude",
            args: buildClaudeVoiceTranscriptCorrectionArgs({
              model,
              jsonSchema: encodeJson(toJsonSchemaObject(VoiceTranscriptCorrectionOutput)),
              ...(effort ? { effort } : {}),
            }),
            cwd: tempDirectory,
            environment: providerEnvironment,
            prompt: buildVoiceTranscriptCorrectionPrompt(input.transcript),
          });
          const envelope = yield* decodeClaudeOutput(stdout).pipe(
            Effect.mapError(
              () =>
                new VoiceTranscriptCorrectionError({
                  kind: "malformed-response",
                  message: "Claude returned invalid structured output.",
                }),
            ),
          );
          return yield* validateVoiceTranscriptCorrectionOutput({
            transcript: input.transcript,
            output: envelope.structured_output,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isVoiceTranscriptCorrectionError(cause)
              ? cause
              : new VoiceTranscriptCorrectionError({
                  kind: "provider-error",
                  message: "Claude transcript correction failed.",
                }),
          ),
        ),
      );

    return { correct };
  });
}
