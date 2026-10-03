import { TextGenerationError, type ModelSelection, type PiSettings } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import {
  getModelSelectionStringOptionValue,
  MODEL_TOKEN_LIMIT_MESSAGE,
} from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../orchestration-v2/Adapters/piT3McpInjection.ts";
import { decodePiModelSlug } from "../provider/pi/PiModel.ts";
import { applyPiModelSelection } from "../provider/pi/PiModelSelection.ts";
import {
  makePiRpcClient,
  type PiRpcClient,
  type PiRpcError,
  type PiRpcSpawnOptions,
} from "../provider/pi/PiRpcClient.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

type PiRpcClientFactory = (
  options: PiRpcSpawnOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>;
const isTextGenerationError = Schema.is(TextGenerationError);
const PI_TEXT_GENERATION_TIMEOUT_MS = 120_000;

export interface PiTextGenerationOptions {
  readonly timeoutMs?: number;
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const assistantText = (message: Record<string, unknown>): string | undefined => {
  if (message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
  return text || undefined;
};

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeRpcClient: PiRpcClientFactory = makePiRpcClient,
  options: PiTextGenerationOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runPiJson = <S extends Schema.Top>(input: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected =
          input.modelSelection.model === "default"
            ? undefined
            : decodePiModelSlug(input.modelSelection.model);
        if (input.modelSelection.model !== "default" && !selected)
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Pi model selection must use the 'provider/model' format.",
          });
        const resolved = resolvePiLaunchArgs(settings.launchArgs);
        if (!resolved.ok)
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: resolved.message,
          });
        const launch = buildPiRpcLaunch({
          launchArgs: resolved.args,
          environment,
          mcpSession: undefined,
          extensionPath: undefined,
          ephemeral: true,
          disableExtensions: true,
          disableTools: true,
        });
        const client = yield* makeRpcClient({
          command: settings.binaryPath || "pi",
          // The typed native client supplies --mode rpc. Naming helpers use no
          // workspace instructions, skills, tools, extensions or persisted session.
          args: [
            ...launch.args.slice(2),
            "--offline",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
          ],
          cwd: input.cwd,
          env: {
            ...launch.env,
            PI_TELEMETRY: "0",
            PI_SKIP_VERSION_CHECK: "1",
            SCIENT_PI_MCP_ENDPOINT: undefined,
            SCIENT_PI_MCP_AUTHORIZATION: undefined,
            SCIENT_PI_AWARENESS: undefined,
          },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to start Pi RPC text generation.",
                cause: String(cause),
              }),
          ),
        );
        const output = yield* Ref.make("");
        const currentDeltas = yield* Ref.make("");
        const outputExhausted = yield* Ref.make(false);
        const settled = yield* Deferred.make<void, TextGenerationError>();
        yield* client.events.pipe(
          Stream.runForEach((native) => {
            if ("_tag" in native && native._tag === "PiRpcProtocolFailureEvent")
              return Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail:
                    typeof native.detail === "string" ? native.detail : "Pi RPC protocol failed.",
                }),
              ).pipe(Effect.asVoid);
            const event = native as Record<string, unknown>;
            if (event.type === "agent_settled")
              return Effect.gen(function* () {
                if (yield* Ref.get(outputExhausted)) {
                  yield* Deferred.fail(
                    settled,
                    new TextGenerationError({
                      operation: input.operation,
                      detail: MODEL_TOKEN_LIMIT_MESSAGE,
                      errorReason: "token_limit",
                    }),
                  );
                } else {
                  yield* Deferred.succeed(settled, undefined);
                }
              });
            if (event.type === "message_start") return Ref.set(currentDeltas, "");
            if (event.type === "message_end") {
              const message = isRecord(event.message) ? event.message : undefined;
              if (!message || message.role !== "assistant") return Effect.void;
              const stopReason = message.stopReason;
              if (stopReason === "error" || stopReason === "aborted")
                return Deferred.fail(
                  settled,
                  new TextGenerationError({
                    operation: input.operation,
                    detail: `Pi assistant stopped with reason '${stopReason}'.`,
                  }),
                ).pipe(Effect.asVoid);
              return Effect.gen(function* () {
                yield* Ref.set(outputExhausted, stopReason === "length");
                const completed = assistantText(message) ?? (yield* Ref.get(currentDeltas));
                yield* Ref.set(output, completed);
                yield* Ref.set(currentDeltas, "");
              });
            }
            const update = event.assistantMessageEvent;
            if (
              event.type === "message_update" &&
              typeof update === "object" &&
              update !== null &&
              "type" in update &&
              update.type === "text_delta" &&
              "delta" in update &&
              typeof update.delta === "string"
            )
              return Ref.update(currentDeltas, (current) => current + update.delta);
            return Effect.void;
          }),
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: Cause.hasInterruptsOnly(cause)
                    ? "Pi event stream ended before generation settled."
                    : "Pi event stream failed before generation settled.",
                  ...(Cause.hasInterruptsOnly(cause) ? {} : { cause }),
                }),
              ),
            onSuccess: () =>
              Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Pi event stream ended before generation settled.",
                }),
              ),
          }),
          Effect.asVoid,
          Effect.forkScoped,
        );
        const thinking =
          getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel") ??
          getModelSelectionStringOptionValue(input.modelSelection, "thinking");
        const before = yield* client.getState();
        if (selected !== undefined || thinking !== undefined) {
          const effectiveModel =
            selected ??
            (before.model === undefined
              ? undefined
              : { provider: before.model.provider, modelId: before.model.id });
          if (effectiveModel === undefined)
            return yield* new TextGenerationError({
              operation: input.operation,
              detail: "Pi did not report its configured default model.",
            });
          yield* applyPiModelSelection(client, effectiveModel, thinking, {
            // --no-session starts a fresh background conversation.
            messageCount: before.messageCount ?? 0,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new TextGenerationError({
                  operation: input.operation,
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
        }
        yield* client.prompt(input.prompt);
        yield* Deferred.await(settled);
        const raw = (yield* Ref.get(output)).trim();
        if (!raw)
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Pi returned empty output.",
          });
        // oxlint-disable-next-line t3code/no-inline-schema-compile -- The caller supplies a distinct output schema per generation request.
        return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
          extractJsonObject(raw),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Pi text generation failed.",
                cause,
              }),
        ),
      ),
    ).pipe(
      Effect.timeout(Duration.millis(options.timeoutMs ?? PI_TEXT_GENERATION_TIMEOUT_MS)),
      Effect.catchTag(
        "TimeoutError",
        () =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Pi text generation timed out.",
          }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
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
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        naming: input.naming,
      });
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        branch: formatGeneratedBranchName(generated.branch, input.naming),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
