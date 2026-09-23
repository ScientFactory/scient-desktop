import { TextGenerationError, type ModelSelection, type OmpSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
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
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { OmpRpcNotification } from "effect-omp-rpc/client";
import { OmpRpcProtocolError, type OmpRpcError } from "effect-omp-rpc/errors";
import { isRecord } from "effect-omp-rpc/schema";

import { decodeOmpModelSlug, ompThinkingLevel } from "../provider/omp/OmpModel.ts";
import {
  OMP_ISOLATED_ARGS,
  makeOmpRpcProcess,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "../provider/omp/OmpRpcProcess.ts";
import type * as Scope from "effect/Scope";
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

const TIMEOUT_MS = 120_000;
const isTextGenerationError = Schema.is(TextGenerationError);
const isProtocolError = Schema.is(OmpRpcProtocolError);

const assistantDelta = (notification: OmpRpcNotification): string | undefined => {
  if (notification._tag !== "Event" || notification.event.type !== "message_update")
    return undefined;
  const update = notification.event.assistantMessageEvent;
  if (!isRecord(update) || update.type !== "text_delta" || typeof update.delta !== "string")
    return undefined;
  return update.delta;
};

const messageRole = (message: unknown): string | undefined =>
  isRecord(message) && typeof message.role === "string" ? message.role.toLowerCase() : undefined;

const messageText = (message: unknown): string | undefined => {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
  return text || undefined;
};

const lastAssistantText = (messages: unknown): string | undefined => {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageRole(message) === "assistant") return messageText(message);
  }
  return undefined;
};

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  makeProcess: (
    options: OmpRpcProcessOptions,
  ) => Effect.Effect<
    OmpRpcProcess,
    OmpRpcError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = makeOmpRpcProcess,
  timeoutMs = TIMEOUT_MS,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        const selected = decodeOmpModelSlug(input.modelSelection.model);
        if (!selected) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Oh My Pi model selection must use the 'provider/model' format.",
          });
        }
        const client = yield* makeProcess({
          command: settings.binaryPath,
          cwd: input.cwd,
          env: environment,
          extraArgs: OMP_ISOLATED_ARGS,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to start Oh My Pi for text generation.",
                ...(isProtocolError(cause) ? { cause: cause.detail } : {}),
              }),
          ),
        );
        const output = yield* Ref.make("");
        const exhausted = yield* Ref.make(false);
        let currentMessageHasDelta = false;
        const settled = yield* Deferred.make<void, TextGenerationError>();
        yield* client.events.pipe(
          Stream.runForEach((notification) => {
            if (
              notification._tag === "ProtocolFailure" ||
              notification._tag === "AsyncCommandFailure"
            ) {
              return Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail:
                    notification._tag === "ProtocolFailure"
                      ? notification.detail
                      : notification.error,
                }),
              ).pipe(Effect.asVoid);
            }
            const event = notification.event;
            if (event.type === "prompt_result" && event.agentInvoked === false) {
              return Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Oh My Pi finished the prompt without a model response.",
                }),
              ).pipe(Effect.asVoid);
            }
            if (event.type === "message_start" && messageRole(event.message) === "assistant") {
              currentMessageHasDelta = false;
              return Effect.void;
            }
            if (event.type === "message_end" && messageRole(event.message) === "assistant") {
              const stopReasonLength =
                isRecord(event.message) && event.message.stopReason === "length";
              const text = currentMessageHasDelta ? undefined : messageText(event.message);
              currentMessageHasDelta = false;
              return Ref.set(exhausted, stopReasonLength).pipe(
                Effect.andThen(
                  text ? Ref.update(output, (current) => current + text) : Effect.void,
                ),
              );
            }
            if (event.type === "agent_end" && event.isTerminal !== false) {
              const fallback = lastAssistantText(event.messages);
              return Ref.get(output).pipe(
                Effect.flatMap((current) =>
                  !current && fallback ? Ref.set(output, fallback) : Effect.void,
                ),
                Effect.andThen(Ref.get(exhausted)),
                Effect.flatMap((tokenLimit) =>
                  tokenLimit
                    ? Deferred.fail(
                        settled,
                        new TextGenerationError({
                          operation: input.operation,
                          detail: MODEL_TOKEN_LIMIT_MESSAGE,
                          errorReason: "token_limit",
                        }),
                      )
                    : Deferred.succeed(settled, undefined),
                ),
                Effect.asVoid,
              );
            }
            const delta = assistantDelta(notification);
            if (delta) {
              currentMessageHasDelta = true;
              return Ref.update(output, (current) => current + delta);
            }
            return Effect.void;
          }),
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: Cause.hasInterruptsOnly(cause)
                    ? "Oh My Pi event stream ended before generation settled."
                    : "Oh My Pi event stream failed before generation settled.",
                }),
              ),
            onSuccess: () =>
              Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Oh My Pi exited before generation settled.",
                }),
              ),
          }),
          Effect.forkScoped,
        );
        const level = ompThinkingLevel(
          getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel"),
        );
        yield* client.setModel(selected.provider, selected.modelId).pipe(
          Effect.andThen(level ? client.setThinkingLevel(level) : Effect.void),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to select the Oh My Pi model.",
                cause: String(cause),
              }),
          ),
        );
        const accepted = yield* client.prompt({ message: input.prompt }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Oh My Pi rejected the text-generation prompt.",
                cause: String(cause),
              }),
          ),
        );
        const invoked = isRecord(accepted.data) ? accepted.data.agentInvoked : undefined;
        if (invoked === false) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Oh My Pi finished the prompt without a model response.",
          });
        }
        yield* Deferred.await(settled);
        const raw = (yield* Ref.get(output)).trim();
        if (!raw) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Oh My Pi returned empty output.",
          });
        }
        // oxlint-disable-next-line t3code/no-inline-schema-compile -- The caller supplies a distinct output schema per generation request.
        return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
          extractJsonObject(raw),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Oh My Pi text generation failed.",
                cause,
              }),
        ),
      ),
    ).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.catchTag(
        "TimeoutError",
        () =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Oh My Pi text generation timed out.",
          }),
      ),
    );

  return {
    generateCommitMessage: (input) => {
      const built = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });
      return runJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map((value) => ({
          subject: sanitizeCommitSubject(value.subject),
          body: value.body.trim(),
          ...("branch" in value && typeof value.branch === "string"
            ? { branch: sanitizeFeatureBranchName(value.branch) }
            : {}),
        })),
      );
    },
    generatePrContent: (input) => {
      const built = buildPrContentPrompt(input);
      return runJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map((value) => ({ title: sanitizePrTitle(value.title), body: value.body.trim() })),
      );
    },
    generateBranchName: (input) => {
      const built = buildBranchNamePrompt(input);
      return runJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(Effect.map((value) => ({ branch: sanitizeBranchFragment(value.branch) })));
    },
    generateThreadTitle: (input) => {
      const built = buildThreadTitlePrompt(input);
      return runJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt: built.prompt,
        outputSchema: built.outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map((value) => ({
          title: sanitizeThreadTitle(value.title),
          ...(value.needsRefinement ? { needsRefinement: true } : {}),
        })),
      );
    },
  } satisfies TextGeneration.TextGeneration["Service"];
});
