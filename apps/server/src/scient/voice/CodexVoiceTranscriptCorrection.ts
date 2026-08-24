import { type CodexSettings, VoiceTranscriptCorrectionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "../../provider/Layers/codexLaunchArgs.ts";
import { toJsonSchemaObject } from "../../textGeneration/TextGenerationUtils.ts";
import type { ProviderVoiceTranscriptCorrection } from "../../provider/ProviderDriver.ts";
import {
  buildVoiceTranscriptCorrectionPrompt,
  validateVoiceTranscriptCorrectionOutput,
  VoiceTranscriptCorrectionOutput,
} from "./VoiceTranscriptCorrectionPrompt.ts";
import { runVoiceTranscriptCorrectionProcess } from "./VoiceTranscriptCorrectionProcess.ts";

const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "shell_snapshot",
  "view_image",
  "image_generation",
  "skill_search",
  "tool_suggest",
  "standalone_web_search",
] as const;
const MAX_CODEX_OUTPUT_BYTES = 64 * 1024;

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isVoiceTranscriptCorrectionError = Schema.is(VoiceTranscriptCorrectionError);

export function buildCodexVoiceTranscriptCorrectionArgs(input: {
  readonly model: string;
  readonly schemaPath: string;
  readonly outputPath: string;
  readonly launchArgs?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return [
    "exec",
    ...(input.launchArgs ?? []),
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--model",
    input.model,
    "--config",
    'model_reasoning_effort="low"',
    ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
    "-",
  ];
}

export function makeCodexVoiceTranscriptCorrection(
  settings: CodexSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  ProviderVoiceTranscriptCorrection,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const providerEnvironment = {
      ...environment,
      ...(settings.homePath ? { CODEX_HOME: expandHomePath(settings.homePath) } : {}),
    };

    const correct: ProviderVoiceTranscriptCorrection["correct"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "scient-voice-codex-",
          });
          const schemaPath = path.join(tempDirectory, "output.schema.json");
          const outputPath = path.join(tempDirectory, "output.json");
          yield* fileSystem.writeFileString(
            schemaPath,
            encodeJson(toJsonSchemaObject(VoiceTranscriptCorrectionOutput)),
          );
          yield* fileSystem.writeFileString(outputPath, "");

          yield* runVoiceTranscriptCorrectionProcess({
            spawner,
            binaryPath: settings.binaryPath?.trim() || "codex",
            args: buildCodexVoiceTranscriptCorrectionArgs({
              model: input.modelSelection.model,
              schemaPath,
              outputPath,
              launchArgs: codexExecLaunchArgs(
                resolveCodexLaunchArgs(settings.launchArgs, providerEnvironment),
              ),
            }),
            cwd: tempDirectory,
            environment: providerEnvironment,
            prompt: buildVoiceTranscriptCorrectionPrompt(input.transcript, input.language),
          });

          const outputInfo = yield* fileSystem.stat(outputPath).pipe(
            Effect.mapError(
              () =>
                new VoiceTranscriptCorrectionError({
                  kind: "malformed-response",
                  message: "Codex did not return a readable correction.",
                }),
            ),
          );
          if (outputInfo.type !== "File" || Number(outputInfo.size) > MAX_CODEX_OUTPUT_BYTES) {
            return yield* new VoiceTranscriptCorrectionError({
              kind: "malformed-response",
              message: "Codex returned an invalid correction.",
            });
          }
          const rawOutput = yield* fileSystem.readFileString(outputPath).pipe(
            Effect.mapError(
              () =>
                new VoiceTranscriptCorrectionError({
                  kind: "malformed-response",
                  message: "Codex did not return a readable correction.",
                }),
            ),
          );
          const decoded = yield* decodeJson(rawOutput).pipe(
            Effect.mapError(
              () =>
                new VoiceTranscriptCorrectionError({
                  kind: "malformed-response",
                  message: "Codex returned invalid structured output.",
                }),
            ),
          );
          return yield* validateVoiceTranscriptCorrectionOutput({
            transcript: input.transcript,
            output: decoded,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isVoiceTranscriptCorrectionError(cause)
              ? cause
              : new VoiceTranscriptCorrectionError({
                  kind: "provider-error",
                  message: "Codex transcript correction failed.",
                }),
          ),
        ),
      );

    return { correct };
  });
}
