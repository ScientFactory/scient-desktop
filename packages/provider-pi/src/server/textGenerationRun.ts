/**
 * One-shot text generation must carry no workspace instructions, skills, tools, extensions, or
 * persisted session. Apply model/effort natively, consume ordered events, and bound total duration.
 */
import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import {
  investigationUnsupported,
  type Operation,
} from "@t3tools/provider-core/server/textGenerationOperations";
import type { PiSettings } from "@t3tools/provider-pi/settings";
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
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { buildPiRpcLaunch, resolvePiLaunchArgs } from "./mcpInjection.ts";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Option from "effect/Option";
import { isPiThinkingLevel } from "./modelCapabilities.ts";
import { applyPiModelSelection } from "./modelSelection.ts";
import { MINIMUM_PI_VERSION, runPiVersionCommand } from "./status.ts";
import { resolvePiModelSlug } from "./rpc.ts";
import type { PiRpcClient, PiRpcError, PiRpcSpawnOptions } from "./rpcClient.ts";

export type PiRpcClientFactory = (
  options: PiRpcSpawnOptions,
) => Effect.Effect<PiRpcClient, PiRpcError, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>;
const isTextGenerationError = Schema.is(TextGenerationError);
const PI_TEXT_GENERATION_TIMEOUT_MS = 120_000;

export interface PiTextGenerationOptions {
  readonly timeoutMs?: number;
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

// Pi's `errorMessage` is the provider's raw response text and can echo
// credentials, so only a leading HTTP status reaches the error detail.
const piTurnErrorDetail = (errorMessage: unknown) => {
  const status =
    typeof errorMessage === "string" ? /^([45]\d\d)\b/.exec(errorMessage)?.[1] : undefined;
  return status === undefined
    ? "Pi could not generate text: the model provider reported an error."
    : `Pi could not generate text: the model provider returned HTTP ${status}.`;
};

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

/** Builds the single structured Pi run that every text generation operation uses. */
export const makePiRunJson = (run: {
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly makeRpcClient: PiRpcClientFactory;
  readonly options: PiTextGenerationOptions;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) => {
  const { settings, environment, makeRpcClient, options, spawner } = run;
  return <S extends Schema.Top>(input: {
    operation: Operation;
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.operation === "generateReviewGuide")
          return yield* investigationUnsupported(input.operation, "Pi");
        const thinking =
          getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel") ??
          getModelSelectionStringOptionValue(input.modelSelection, "thinking");
        if (thinking !== undefined && isPiThinkingLevel(thinking)) {
          // Earlier Pi saves a background thinking change as the user's global default.
          const output = yield* runPiVersionCommand(settings, environment, input.cwd).pipe(
            Effect.timeoutOption(4_000),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.orElseSucceed(() => Option.none()),
          );
          const version =
            Option.isSome(output) && output.value.code === 0
              ? parseGenericCliVersion(`${output.value.stdout}
${output.value.stderr}`)
              : null;
          if (version === null || compareSemverVersions(version, MINIMUM_PI_VERSION) < 0)
            return yield* new TextGenerationError({
              operation: input.operation,
              detail: `Pi ${MINIMUM_PI_VERSION} or newer is required for text generation thinking options. Update Pi and try again.`,
            });
        }
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
          // Stopped as soon as it answers, so Pi's startup refresh must not rotate OAuth tokens.
          shortLived: true,
          disableExtensions: true,
          disableTools: true,
        });
        const client = yield* makeRpcClient({
          command: settings.binaryPath || "pi",
          // The typed native client supplies --mode rpc. Naming helpers use no
          // workspace instructions, skills, tools, extensions or persisted session.
          args: [
            ...launch.args.slice(2),
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
        // Pi provider names and model ids may contain "/", so a custom slug resolves through the
        // `{provider, id}` pairs Pi reports before falling back to the canonical encoding.
        let selected: { readonly provider: string; readonly modelId: string } | undefined;
        if (input.modelSelection.model !== "default") {
          const reported = yield* client.getAvailableModels().pipe(
            Effect.map((inventory) => inventory.models),
            Effect.orElseSucceed(() => undefined),
          );
          selected = resolvePiModelSlug(input.modelSelection.model, reported) ?? undefined;
          if (!selected)
            return yield* new TextGenerationError({
              operation: input.operation,
              detail: "Pi model selection must use the 'provider/model' format.",
            });
        }
        const output = yield* Ref.make("");
        const currentDeltas = yield* Ref.make("");
        const outputExhausted = yield* Ref.make(false);
        // Pi can retry after a provider failure and still answer, so only the latest turn counts.
        const turnError = yield* Ref.make<string | undefined>(undefined);
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
              if (stopReason === "aborted")
                return Deferred.fail(
                  settled,
                  new TextGenerationError({
                    operation: input.operation,
                    detail: `Pi assistant stopped with reason '${stopReason}'.`,
                  }),
                ).pipe(Effect.asVoid);
              if (stopReason === "error")
                return Effect.gen(function* () {
                  yield* Ref.set(turnError, piTurnErrorDetail(message.errorMessage));
                  yield* Ref.set(outputExhausted, false);
                  yield* Ref.set(output, "");
                  yield* Ref.set(currentDeltas, "");
                });
              return Effect.gen(function* () {
                yield* Ref.set(turnError, undefined);
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
                  detail:
                    cause.kind === "request" && cause.command === "set_model"
                      ? `Pi rejected model '${input.modelSelection.model}': ${cause.detail}. ` +
                        "If the model comes from a Pi extension or package, text generation cannot use it " +
                        "because it runs Pi with --no-extensions. Pick a built-in Pi model or one defined " +
                        "in Pi's models.json."
                      : cause.detail,
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
            detail: (yield* Ref.get(turnError)) ?? "Pi returned empty output.",
          });
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
                detail: "Pi text generation failed.",
                cause,
              }),
        ),
      ),
    ).pipe(
      Effect.timeout(Duration.millis(options.timeoutMs ?? PI_TEXT_GENERATION_TIMEOUT_MS)),
      Effect.catchTags({
        TimeoutError: () =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Pi text generation timed out.",
          }),
      }),
    );
};
