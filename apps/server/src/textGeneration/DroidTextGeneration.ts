import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { DROID_DEFAULT_MODEL, type DroidSettings, type ModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { MODEL_TOKEN_LIMIT_MESSAGE } from "@t3tools/shared/model";

import { TextGenerationError } from "@t3tools/contracts";
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
} from "./TextGenerationUtils.ts";
import {
  applyDroidModelAndEffort,
  findDroidAutonomyOption,
  findSelectDroidConfigOption,
  requestedDroidEffortFromSelection,
  type DroidAcpRuntime,
  type DroidAcpRuntimeFactory,
  type DroidToolGuard,
} from "../provider/acp/DroidAcpSupport.ts";

const DROID_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/**
 * Applies the model/effort selection for a disposable text-generation
 * runtime, mapping ACP errors onto `TextGenerationError`. The shared helper
 * enforces model-before-effort ordering and live-ladder validation.
 */
const applyDroidTextGenerationSelection = (input: {
  readonly runtime: Parameters<typeof applyDroidModelAndEffort>[0]["runtime"];
  readonly requestedModel: string | undefined;
  readonly requestedEffort: string | undefined;
  readonly operation: TextGenerationOperation;
}): Effect.Effect<void, TextGenerationError> =>
  applyDroidModelAndEffort({
    runtime: input.runtime,
    requestedModel: input.requestedModel,
    requestedEffort: input.requestedEffort,
  }).pipe(
    // Background generation runs at the level Droid applies; there is no thread to tell.
    Effect.asVoid,
    Effect.mapError((cause): TextGenerationError =>
      isTextGenerationError(cause)
        ? cause
        : new TextGenerationError({
            operation: input.operation,
            // Invalid-selection errors are Scient's own explanation of the choice.
            detail:
              isAcpRequestError(cause) && cause.code === -32602
                ? cause.message
                : "Failed to apply Droid ACP model selection for text generation.",
            cause,
          }),
    ),
  );

const selectValues = (option: ReturnType<typeof findSelectDroidConfigOption>) =>
  option?.type === "select"
    ? option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    : [];

/**
 * The model for background text when Scient chooses it (`DROID_DEFAULT_MODEL`)
 * and not the user: titles and commit messages do not need the account's
 * default model. Droid describes each Factory model by its token rate
 * ("0.08x Factory token rate"); the lowest rate wins, deprecated models
 * aside. Undefined when Droid reports no rate: its own default stays.
 */
function cheapestDroidModel(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  let cheapest: { readonly value: string; readonly rate: number } | undefined;
  for (const model of selectValues(
    findSelectDroidConfigOption(configOptions, { category: "model", id: "model" }),
  )) {
    const rate = /^(\d+(?:\.\d+)?)x\s/i.exec(model.description?.trim() ?? "")?.[1];
    if (rate === undefined || model.name.includes("[Deprecated]")) continue;
    if (cheapest === undefined || Number(rate) < cheapest.rate)
      cheapest = { value: model.value, rate: Number(rate) };
  }
  return cheapest?.value;
}

const EFFORT_ORDER = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The lowest reasoning level the selected model takes; undefined when it offers none. */
function lowestDroidEffort(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const offered = new Set(
    selectValues(
      findSelectDroidConfigOption(configOptions, {
        id: "reasoning_effort",
        category: "thought_level",
      }),
    ).map((level) => level.value),
  );
  return EFFORT_ORDER.find((level) => offered.has(level));
}

/**
 * Background prompts carry untrusted diffs and messages, so they run without
 * tools: Scient custom models receive no tool definitions, and the process
 * refuses every tool call before it runs (see `modelTools`). As a second
 * line, they run at Droid's lowest autonomy, confirmed by Droid's own report
 * before anything is sent, and every permission request is rejected.
 * Verified against Droid 0.228.0: at `normal` every shell command asks for
 * permission; `spec` asks the same but turns the task into planning.
 */
const BACKGROUND_AUTONOMY = "normal";

const applyBackgroundAutonomy = (
  runtime: Pick<DroidAcpRuntime, "getConfigOptions" | "setConfigOption">,
  operation: TextGenerationOperation,
): Effect.Effect<void, TextGenerationError> =>
  Effect.gen(function* () {
    const option = findDroidAutonomyOption(yield* runtime.getConfigOptions);
    const offered =
      option?.type === "select" &&
      option.options.some((entry) =>
        "value" in entry
          ? entry.value === BACKGROUND_AUTONOMY
          : entry.options.some((nested) => nested.value === BACKGROUND_AUTONOMY),
      );
    if (!option || !offered)
      return yield* new TextGenerationError({
        operation,
        detail: "Droid does not offer read-only autonomy, so the background request was not sent.",
      });
    yield* runtime.setConfigOption(option.id, BACKGROUND_AUTONOMY);
    const applied = findSelectDroidConfigOption(yield* runtime.getConfigOptions, {
      id: option.id,
    });
    if (applied?.currentValue !== BACKGROUND_AUTONOMY)
      return yield* new TextGenerationError({
        operation,
        detail: "Droid did not confirm read-only autonomy, so the background request was not sent.",
      });
  }).pipe(
    Effect.mapError((cause) =>
      isTextGenerationError(cause)
        ? cause
        : new TextGenerationError({
            operation,
            detail:
              "Droid could not set read-only autonomy, so the background request was not sent.",
            cause,
          }),
    ),
  );

/**
 * `environment` is the complete Droid process environment (the agent
 * environment contract) and `makeAcpRuntime` must enforce `modelTools`
 * (the custom-models factory): neither has a default that could run a
 * background prompt with the server's environment or with tools.
 */
const BACKGROUND_TASKS = "titles, commit messages, PR text and branch names";
type UnconfirmedToolGuard = Exclude<DroidToolGuard, "enforced">;
const toolGuardReason = (guard: UnconfirmedToolGuard) =>
  guard === "disabled-by-policy"
    ? "Your organization's Droid policy disables Scient's tool blocking"
    : "Scient could not confirm that your organization's Droid policy allows its tool blocking";

/** Why Droid runs no background generation, on any model, Scient custom models included. */
export const droidToolGuardRefusal = (guard: UnconfirmedToolGuard) =>
  `${toolGuardReason(guard)}, so Scient won't run background generation (${BACKGROUND_TASKS}) with Droid. Choose another provider for these in Settings.`;

/** Carried as the refusal's cause, so the custom-model Test can say it in its own words. */
class DroidToolGuardUnconfirmed extends Schema.TaggedError<DroidToolGuardUnconfirmed>()(
  "DroidToolGuardUnconfirmed",
  { guard: Schema.Literals(["disabled-by-policy", "unconfirmed"]) },
) {}
const isDroidToolGuardUnconfirmed = Schema.is(DroidToolGuardUnconfirmed);

/**
 * The same refusal for the custom-model Test, which runs through background
 * generation: undefined for any other failure. The model itself stays usable
 * in Droid threads, where the user's own autonomy applies.
 */
export const droidToolGuardTestRefusal = (error: TextGenerationError): string | undefined =>
  !isDroidToolGuardUnconfirmed(error.cause)
    ? undefined
    : error.cause.guard === "disabled-by-policy"
      ? `${toolGuardReason(error.cause.guard)}, which the test needs, so the test was not run. To try this model, send a message in a Droid thread.`
      : `${toolGuardReason(error.cause.guard)}, which the test needs, so the test was not run. Test again, or send a message in a Droid thread to try this model.`;

/**
 * Background generation runs only when Droid shows it will refuse every tool
 * call (see `backgroundToolGuard`); otherwise nothing is sent, whatever the
 * model.
 */
const requireBackgroundToolGuard = (
  runtime: Pick<DroidAcpRuntime, "backgroundToolGuard">,
  operation: TextGenerationOperation,
): Effect.Effect<void, TextGenerationError> =>
  Effect.gen(function* () {
    const guard = runtime.backgroundToolGuard
      ? yield* runtime.backgroundToolGuard()
      : "unconfirmed";
    if (guard !== "enforced")
      return yield* new TextGenerationError({
        operation,
        detail: droidToolGuardRefusal(guard),
        cause: new DroidToolGuardUnconfirmed({ guard }),
      });
  });

export const makeDroidTextGeneration = Effect.fn("makeDroidTextGeneration")(function* (
  droidSettings: DroidSettings,
  environment: NodeJS.ProcessEnv,
  makeAcpRuntime: DroidAcpRuntimeFactory,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runDroidJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeAcpRuntime({
        droidSettings,
        environment,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "scient-git-text", version: "0.0.0" },
        modelTools: "disabled",
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      // Nothing a background prompt asks for is ever granted.
      yield* runtime.handleRequestPermission((request) => {
        const reject = request.options.find((option) => option.kind === "reject_once");
        return Effect.succeed({
          outcome: reject
            ? ({ outcome: "selected", optionId: reject.optionId } as const)
            : ({ outcome: "cancelled" } as const),
        });
      });
      yield* runtime.handleElicitation(() => Effect.succeed({ action: "cancel" as const }));

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        // A model chosen in Settings wins. Left to Scient, the cheapest one does.
        const cheapest =
          modelSelection.model === DROID_DEFAULT_MODEL
            ? cheapestDroidModel(yield* runtime.getConfigOptions)
            : undefined;
        const requestedEffort = requestedDroidEffortFromSelection(modelSelection.options);
        yield* applyDroidTextGenerationSelection({
          runtime,
          requestedModel: cheapest ?? modelSelection.model,
          requestedEffort,
          operation,
        });
        // Its levels are known only once it is selected.
        const lowest =
          cheapest !== undefined && requestedEffort === undefined
            ? lowestDroidEffort(yield* runtime.getConfigOptions)
            : undefined;
        if (lowest !== undefined)
          yield* applyDroidTextGenerationSelection({
            runtime,
            requestedModel: undefined,
            requestedEffort: lowest,
            operation,
          });
        yield* applyBackgroundAutonomy(runtime, operation);
        yield* requireBackgroundToolGuard(runtime, operation);

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(DROID_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Droid ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Droid ACP request failed.",
                cause,
              }),
        ),
      );

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (promptResult.stopReason === "max_tokens") {
        return yield* new TextGenerationError({
          operation,
          detail: MODEL_TOKEN_LIMIT_MESSAGE,
          errorReason: "token_limit",
        });
      }
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Droid ACP request was cancelled."
              : "Droid Agent returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Droid Agent returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Droid ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("DroidTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runDroidJson({
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
    Effect.fn("DroidTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runDroidJson({
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
    Effect.fn("DroidTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runDroidJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("DroidTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runDroidJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
