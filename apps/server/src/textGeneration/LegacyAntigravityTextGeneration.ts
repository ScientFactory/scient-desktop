/** Structured one-shot generation through Antigravity's native NDJSON mode. */

import {
  type AntigravitySettings,
  type ChatAttachment,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { makeAgySession } from "../provider/antigravity/AgySession.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

const ANTIGRAVITY_TIMEOUT_MS = 180_000;
const DEFAULT_MODEL = "gemini-3.7-flash";
const DEFAULT_EFFORT = "low";
const isTextGenerationError = Schema.is(TextGenerationError);
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type Operation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

function generationError(operation: Operation, detail: string, cause?: unknown) {
  return new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });
}

export const makeAntigravityTextGeneration = Effect.fn("makeAntigravityTextGeneration")(function* (
  antigravitySettings: AntigravitySettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const stageAttachments = Effect.fn("AntigravityTextGeneration.stageAttachments")(function* (
    operation: Operation,
    attachments: ReadonlyArray<ChatAttachment> | undefined,
  ) {
    const stagingDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "scient-antigravity-text-attachments-",
    });
    const stagedPaths: string[] = [];
    for (const attachment of attachments ?? []) {
      const source = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!source || !path.isAbsolute(source)) {
        return yield* generationError(
          operation,
          `Attachment '${attachment.name}' has an invalid storage path.`,
        );
      }
      const info = yield* fileSystem
        .stat(source)
        .pipe(
          Effect.mapError((cause) =>
            generationError(operation, `Attachment '${attachment.name}' is unavailable.`, cause),
          ),
        );
      if (info.type !== "File") {
        return yield* generationError(operation, `Attachment '${attachment.name}' is not a file.`);
      }
      const destination = path.join(stagingDir, path.basename(source));
      yield* fileSystem
        .copyFile(source, destination)
        .pipe(
          Effect.mapError((cause) =>
            generationError(
              operation,
              `Scient could not stage attachment '${attachment.name}' for Antigravity.`,
              cause,
            ),
          ),
        );
      stagedPaths.push(destination);
    }
    return { stagingDir, stagedPaths };
  });

  const runAntigravityJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection,
    attachments,
  }: {
    readonly operation: Operation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const schemaJson = yield* encodeJson(toJsonSchemaObject(outputSchema)).pipe(
        Effect.mapError((cause) =>
          generationError(operation, "Failed to encode the structured output schema.", cause),
        ),
      );
      const { stagingDir, stagedPaths } = yield* stageAttachments(operation, attachments);
      const promptWithAttachments =
        stagedPaths.length === 0
          ? prompt
          : `${prompt}\n\n${stagedPaths
              .map((filePath) => `[Attached image is available at: ${filePath}]`)
              .join("\n")}`;
      const model = modelSelection.model.trim() || DEFAULT_MODEL;
      const effort =
        getModelSelectionStringOptionValue(modelSelection, "reasoning")?.trim() ||
        getModelSelectionStringOptionValue(modelSelection, "effort")?.trim() ||
        DEFAULT_EFFORT;
      const session = yield* makeAgySession({
        binaryPath: antigravitySettings.binaryPath?.trim() || "agy",
        cwd,
        environment,
        model,
        effort,
        runtimeMode: "approval-required",
        printTimeout: "3m",
        jsonSchema: schemaJson,
        addDirs: [stagingDir],
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          generationError(operation, "Scient could not start Antigravity text generation.", cause),
        ),
      );
      const timed = yield* session.prompt({ text: promptWithAttachments }).pipe(
        Effect.timeoutOption(ANTIGRAVITY_TIMEOUT_MS),
        Effect.mapError((cause) =>
          generationError(operation, "Antigravity text generation failed.", cause),
        ),
      );
      if (Option.isNone(timed)) {
        return yield* generationError(operation, "Antigravity text generation timed out.");
      }
      const result = timed.value;
      if (result.status !== "success") {
        return yield* generationError(
          operation,
          result.error?.trim() || `Antigravity text generation ended with ${result.status}.`,
        );
      }
      if (result.structuredOutput === undefined) {
        return yield* generationError(
          operation,
          "Antigravity did not return the requested structured output.",
        );
      }
      return yield* Schema.decodeUnknownEffect(outputSchema)(result.structuredOutput).pipe(
        Effect.mapError((cause) =>
          generationError(operation, "Antigravity returned invalid structured output.", cause),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : generationError(operation, "Antigravity text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AntigravityTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runAntigravityJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AntigravityTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runAntigravityJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AntigravityTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runAntigravityJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AntigravityTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runAntigravityJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
