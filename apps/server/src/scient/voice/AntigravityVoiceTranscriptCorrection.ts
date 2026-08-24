import { type AntigravitySettings, VoiceTranscriptCorrectionError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeAgySession } from "../../provider/antigravity/AgySession.ts";
import { toJsonSchemaObject } from "../../textGeneration/TextGenerationUtils.ts";
import type { ProviderVoiceTranscriptCorrection } from "../../provider/ProviderDriver.ts";
import {
  buildVoiceTranscriptCorrectionPrompt,
  validateVoiceTranscriptCorrectionOutput,
  VoiceTranscriptCorrectionOutput,
} from "./VoiceTranscriptCorrectionPrompt.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const isVoiceTranscriptCorrectionError = Schema.is(VoiceTranscriptCorrectionError);

function providerFailure(message: string): VoiceTranscriptCorrectionError {
  return new VoiceTranscriptCorrectionError({ kind: "provider-error", message });
}

export function makeAntigravityVoiceTranscriptCorrection(
  settings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.Effect<
  ProviderVoiceTranscriptCorrection,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const correct: ProviderVoiceTranscriptCorrection["correct"] = (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "scient-voice-antigravity-",
          });
          const session = yield* makeAgySession({
            binaryPath: settings.binaryPath?.trim() || "agy",
            cwd: tempDirectory,
            environment,
            model: input.modelSelection.model,
            effort: "low",
            runtimeMode: "approval-required",
            // Let agy finish its own timeout and cleanup before the router's
            // 12-second hard deadline interrupts the provider effect.
            printTimeout: "10s",
            jsonSchema: encodeJson(toJsonSchemaObject(VoiceTranscriptCorrectionOutput)),
            sandbox: true,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(() =>
              providerFailure("Antigravity transcript correction could not start."),
            ),
          );
          const toolAttempted = yield* Ref.make(false);
          const result = yield* session
            .prompt({
              text: buildVoiceTranscriptCorrectionPrompt(input.transcript, input.language),
              onEvent: (event) =>
                event._tag === "ToolCall"
                  ? Ref.set(toolAttempted, true).pipe(Effect.andThen(session.cancel))
                  : Effect.void,
            })
            .pipe(
              Effect.mapError(() => providerFailure("Antigravity transcript correction failed.")),
            );

          if (yield* Ref.get(toolAttempted)) {
            return yield* providerFailure("Antigravity attempted to use a tool during correction.");
          }
          if (result.status !== "success" || result.structuredOutput === undefined) {
            return yield* providerFailure("Antigravity did not return a correction.");
          }
          return yield* validateVoiceTranscriptCorrectionOutput({
            transcript: input.transcript,
            output: result.structuredOutput,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isVoiceTranscriptCorrectionError(cause)
              ? cause
              : providerFailure("Antigravity transcript correction failed."),
          ),
        ),
      );

    return { correct };
  });
}
