import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
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
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import type { OmpRpcNotification } from "effect-omp-rpc/client";
import { OmpRpcProtocolError, type OmpRpcError } from "effect-omp-rpc/errors";
import { isRecord, type OmpRpcEvent } from "effect-omp-rpc/schema";

import { decodeOmpModelSlug, ompThinkingLevel } from "../provider/omp/OmpModel.ts";
import {
  OMP_ISOLATED_ARGS,
  type OmpRpcProcess,
  type OmpRpcProcessOptions,
} from "../provider/omp/OmpRpcProcess.ts";
import type { OmpLaunchSettings } from "../provider/OmpProvider.ts";
import type { OmpTarget } from "../provider/omp/OmpTarget.ts";
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

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * UI-only failure text: an error notice or an extension error. It names the
 * cause when the turn fails without its own error text, but never fails a
 * generation by itself.
 */
const fallbackDetail = (event: OmpRpcEvent): string | undefined => {
  if (event.type === "notice" && event.level === "error") return nonEmpty(event.message);
  if (event.type === "extension_error") return nonEmpty(event.error);
  return undefined;
};

/**
 * The model failure an assistant message reports: `stopReason` `error` or
 * `aborted`, with OMP's `errorMessage` as the cause.
 */
const assistantFailure = (target: OmpTarget, message: unknown): string | undefined => {
  if (!isRecord(message)) return undefined;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
  return (
    nonEmpty(message.errorMessage) ??
    (message.stopReason === "aborted"
      ? `${target.name} aborted the model request.`
      : `${target.name}'s model request failed.`)
  );
};

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
  target: OmpTarget,
  settings: Pick<OmpLaunchSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  makeProcess: (
    options: OmpRpcProcessOptions,
  ) => Effect.Effect<
    OmpRpcProcess,
    OmpRpcError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
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
            detail: `${target.name} model selection must use the 'provider/model' format.`,
          });
        }
        const client = yield* makeProcess({
          target,
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
                detail: `Failed to start ${target.name} for text generation.`,
                ...(isProtocolError(cause) ? { cause: cause.detail } : {}),
              }),
          ),
        );
        const output = yield* Ref.make("");
        const exhausted = yield* Ref.make(false);
        const modelError = yield* Ref.make<string | null>(null);
        /** The current attempt's model failure; a session retry clears it. */
        const attemptFailure = yield* Ref.make<string | null>(null);
        let currentMessageHasDelta = false;
        const settled = yield* Deferred.make<void, TextGenerationError>();
        // Deferred.fail and Deferred.succeed are no-ops once settled, so the
        // first terminal signal wins. The detail is OMP's text, which can
        // echo a custom-model key the provider rejected.
        const fail = (detail: string) =>
          Deferred.fail(
            settled,
            new TextGenerationError({
              operation: input.operation,
              detail: client.redaction.text(detail),
            }),
          ).pipe(Effect.asVoid);
        const failWith = (detail: string | undefined) =>
          Effect.all([Ref.get(attemptFailure), Ref.get(modelError)]).pipe(
            Effect.flatMap(([failure, notice]) =>
              fail(detail ?? failure ?? notice ?? `${target.name}'s model request failed.`),
            ),
          );
        yield* client.events.pipe(
          Stream.runForEach((notification) => {
            if (notification._tag === "ProtocolFailure") return fail(notification.detail);
            if (notification._tag === "AsyncCommandFailure") return fail(notification.error);
            if (notification._tag !== "Event") return Effect.void;
            const event = notification.event;
            const fallback = fallbackDetail(event);
            if (fallback) return Ref.set(modelError, fallback);
            if (event.type === "auto_retry_start") {
              // A new attempt replaces everything the failed one produced.
              currentMessageHasDelta = false;
              return Effect.all([
                Ref.set(output, ""),
                Ref.set(exhausted, false),
                Ref.set(attemptFailure, null),
              ]).pipe(Effect.asVoid);
            }
            if (event.type === "auto_retry_end" && event.success === false) {
              return failWith(nonEmpty(event.finalError));
            }
            if (event.type === "prompt_result") {
              if (event.agentInvoked === false) {
                return fail(`${target.name} finished the prompt without a model response.`);
              }
              if (event.status === "error" || event.status === "aborted") {
                return Ref.get(attemptFailure).pipe(
                  Effect.flatMap((failure) =>
                    failWith(failure ?? nonEmpty(event.promptError?.message)),
                  ),
                );
              }
              return Effect.void;
            }
            if (event.type === "message_start" && messageRole(event.message) === "assistant") {
              currentMessageHasDelta = false;
              return Effect.void;
            }
            if (event.type === "message_end" && messageRole(event.message) === "assistant") {
              const failure = assistantFailure(target, event.message);
              if (failure) {
                currentMessageHasDelta = false;
                return Ref.set(attemptFailure, failure);
              }
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
              return Ref.get(attemptFailure).pipe(
                Effect.flatMap((failure) => {
                  if (failure) return fail(failure);
                  const fallbackText = lastAssistantText(event.messages);
                  return Ref.get(output).pipe(
                    Effect.flatMap((current) =>
                      !current && fallbackText ? Ref.set(output, fallbackText) : Effect.void,
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
                }),
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
                    ? `${target.name} event stream ended before generation settled.`
                    : `${target.name} event stream failed before generation settled.`,
                }),
              ),
            onSuccess: () =>
              Deferred.fail(
                settled,
                new TextGenerationError({
                  operation: input.operation,
                  detail: `${target.name} exited before generation settled.`,
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
                detail: `Failed to select the ${target.name} model.`,
                cause: client.redaction.text(String(cause)),
              }),
          ),
        );
        const accepted = yield* client.prompt({ message: input.prompt }).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: `${target.name} rejected the text-generation prompt.`,
                cause: client.redaction.text(String(cause)),
              }),
          ),
        );
        const invoked = isRecord(accepted.data) ? accepted.data.agentInvoked : undefined;
        if (invoked === false) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: client.redaction.text(
              (yield* Ref.get(modelError)) ??
                `${target.name} finished the prompt without a model response.`,
            ),
          });
        }
        yield* Deferred.await(settled);
        const raw = (yield* Ref.get(output)).trim();
        if (!raw) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: client.redaction.text(
              (yield* Ref.get(modelError)) ?? `${target.name} returned empty output.`,
            ),
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
                detail: `${target.name} text generation failed.`,
                cause,
              }),
        ),
      ),
    ).pipe(
      Effect.timeout(Duration.millis(timeoutMs)),
      Effect.catchTags({
        TimeoutError: () =>
          new TextGenerationError({
            operation: input.operation,
            detail: `${target.name} text generation timed out.`,
          }),
      }),
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
