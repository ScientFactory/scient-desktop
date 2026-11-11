import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  OMP_DEFAULT_TEXT_GENERATION_MODEL,
  PI_DEFAULT_TEXT_GENERATION_MODEL,
  SCIENT_DEFAULT_TEXT_GENERATION_MODEL,
  TextGenerationError,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { resolveAutomaticModel } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import {
  defaultTextGenerationModel,
  fallbackTextGenerationModelSelection,
} from "@t3tools/shared/serverSettings";
import * as ServerSettings from "../serverSettings.ts";

import type { ModelSelection, ProjectId } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import {
  encodeAgentModelSlug,
  splitAgentModelSlug,
} from "@t3tools/provider-core/server/agentModel";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import * as TextGenerators from "./TextGenerators.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ReviewGuideGenerationInput,
  ReviewGuideGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
  TranscriptionPostProcessingInput,
  TranscriptionPostProcessingResult,
} from "@t3tools/provider-core/server/textGeneration";

export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateReviewGuide"
  | "generateTranscriptionPostProcessing";

const resolveGeneration = Effect.fn("TextGeneration.resolveGeneration")(function* (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  selection: ModelSelection,
): Effect.fn.Return<
  { textGeneration: ProviderInstance["textGeneration"]; modelSelection: ModelSelection },
  TextGenerationError
> {
  const instanceId = selection.instanceId;
  const instance = yield* registry.getInstance(instanceId);
  if (!instance) {
    return yield* new TextGenerationError({
      operation,
      detail: `No provider instance registered for id '${instanceId}'.`,
    });
  }
  const automatic =
    (instance.driverKind === "pi" && selection.model === PI_DEFAULT_TEXT_GENERATION_MODEL) ||
    (instance.driverKind === "omp" && selection.model === OMP_DEFAULT_TEXT_GENERATION_MODEL) ||
    (instance.driverKind === "scient" && selection.model === SCIENT_DEFAULT_TEXT_GENERATION_MODEL);
  if (!automatic) return { textGeneration: instance.textGeneration, modelSelection: selection };

  // Read the catalog already owned by discovery. Metadata generation must not
  // launch another probe or silently replace an explicit model selection.
  const snapshot = yield* instance.snapshot.getSnapshot;
  const models = snapshot.models.filter((model) => {
    const decoded = splitAgentModelSlug(model.slug);
    return decoded && encodeAgentModelSlug(decoded.provider, decoded.modelId) === model.slug;
  });
  const model =
    models.length > 0 &&
    instance.enabled &&
    snapshot.instanceId === instanceId &&
    snapshot.driver === instance.driverKind &&
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.status === "ready" &&
    !snapshot.probePending &&
    snapshot.availability !== "unavailable" &&
    snapshot.supportsTextGeneration !== false
      ? resolveAutomaticModel(instance.driverKind, models)
      : undefined;
  if (!model) {
    return yield* new TextGenerationError({
      operation,
      detail: `No supported automatic text-generation model is available for '${instanceId}'. Check this provider in Settings or select a supported text-generation model.`,
    });
  }
  return {
    textGeneration: instance.textGeneration,
    modelSelection: { ...selection, model },
  };
});

// Review guides investigate the checkout read-only; the other drivers reject that request.
const INVESTIGATING_DRIVERS = new Set(["codex", "claudeAgent"]);

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGenerators = yield* TextGenerators.TextGenerators;
  const generate = Effect.fn("TextGeneration.generate")(function* <A>(
    operation: TextGenerationOp,
    selection: ModelSelection,
    projectId: ProjectId | null | undefined,
    invoke: (
      service: ProviderTextGeneration,
      modelSelection: ModelSelection,
    ) => Effect.Effect<A, TextGenerationError>,
  ) {
    const textGenerator = yield* textGenerators.runner(selection.instanceId);
    // A review guide reaches a text generator only through a fallback; it needs an agent instead.
    const textGeneratorId = selection.instanceId;
    const textGeneratorCannotRun =
      textGenerator !== undefined && operation === "generateReviewGuide";
    if (textGenerator !== undefined && !textGeneratorCannotRun) {
      return yield* invoke(
        TextGenerationOperations.fromRunner("TextGenerator", textGenerator),
        selection,
      );
    }
    const snapshots = yield* registry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
      ),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const selected = snapshots.find((provider) => provider.instanceId === selection.instanceId);
    // Only a failed probe counts: a pending one is also not installed yet.
    const unusable =
      textGeneratorCannotRun ||
      (selected?.enabled === true &&
        selected.status === "error" &&
        (!selected.installed || selected.auth.status === "unauthenticated"));
    if (unusable || exhaustedUsageWindow(selected, now, selection.model)) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not read fallback model settings.",
              cause,
            }),
        ),
      );
      selection =
        fallbackTextGenerationModelSelection(
          settings.providerInstances,
          (instanceId, driver) => {
            const provider = snapshots.find((candidate) => candidate.instanceId === instanceId);
            return (
              instanceId !== selection.instanceId &&
              provider?.enabled === true &&
              resolveProjectProviderInstanceEnabled(settings, projectId ?? null, instanceId) &&
              provider.installed &&
              provider.auth.status !== "unauthenticated" &&
              provider.status !== "error" &&
              isProviderAvailable(provider) &&
              isProviderTextGenerationCapable(provider) &&
              (operation !== "generateReviewGuide" || INVESTIGATING_DRIVERS.has(driver)) &&
              !exhaustedUsageWindow(provider, now, defaultTextGenerationModel(driver))
            );
          },
          { includeConfiguredInstances: true },
        ) ?? selection;
    }
    if (textGeneratorCannotRun && selection.instanceId === textGeneratorId) {
      return yield* new TextGenerationError({
        operation,
        detail:
          "Review guides need a coding agent that can read the checkout. None is ready. Pick Codex or Claude as the review guide model in Settings → Source control.",
      });
    }
    // SCIENT-FORK: resolve Pi/OMP/Scient automatic text-generation models after the fallback.
    return yield* resolveGeneration(registry, operation, selection).pipe(
      Effect.flatMap(({ textGeneration, modelSelection }) =>
        invoke(textGeneration, modelSelection),
      ),
    );
  });
  return TextGeneration.of({
    generateCommitMessage: Effect.fn("TextGeneration.generateCommitMessage")(function (input) {
      return generate(
        "generateCommitMessage",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateCommitMessage({ ...input, modelSelection }),
      );
    }),
    generatePrContent: Effect.fn("TextGeneration.generatePrContent")(function (input) {
      return generate(
        "generatePrContent",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generatePrContent({ ...input, modelSelection }),
      );
    }),
    generateBranchName: Effect.fn("TextGeneration.generateBranchName")(function (input) {
      return generate(
        "generateBranchName",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateBranchName({ ...input, modelSelection }),
      );
    }),
    generateReviewGuide: Effect.fn("TextGeneration.generateReviewGuide")(function (input) {
      return generate(
        "generateReviewGuide",
        input.modelSelection,
        input.projectId,
        (service, modelSelection) => service.generateReviewGuide({ ...input, modelSelection }),
      );
    }),
    generateTranscriptionPostProcessing: Effect.fn(
      "TextGeneration.generateTranscriptionPostProcessing",
    )(function (input) {
      return generate(
        "generateTranscriptionPostProcessing",
        input.modelSelection,
        null,
        (service, modelSelection) =>
          service.generateTranscriptionPostProcessing({ ...input, modelSelection }),
      );
    }),
    generateThreadTitle: Effect.fn("TextGeneration.generateThreadTitle")(function (input) {
      return generate(
        "generateThreadTitle",
        input.modelSelection,
        input.projectId,
        (textGeneration, modelSelection) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({
              ...input,
              linkedContext,
              modelSelection,
            });
          }),
      );
    }),
  });
});

export const layer = Layer.effect(TextGeneration, make).pipe(
  Layer.provideMerge(TextGenerators.layer),
);
