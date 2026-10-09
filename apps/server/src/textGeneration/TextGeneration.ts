import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  OMP_DEFAULT_TEXT_GENERATION_MODEL,
  PI_DEFAULT_TEXT_GENERATION_MODEL,
  SCIENT_DEFAULT_TEXT_GENERATION_MODEL,
  TextGenerationError,
} from "@t3tools/contracts";
import { resolveAutomaticModel } from "@t3tools/shared/model";

import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { encodeAgentModelSlug, splitAgentModelSlug } from "../provider/agentModel.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  return TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveGeneration(registry, "generateCommitMessage", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateCommitMessage({ ...input, modelSelection }),
        ),
      ),
    generatePrContent: (input) =>
      resolveGeneration(registry, "generatePrContent", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generatePrContent({ ...input, modelSelection }),
        ),
      ),
    generateBranchName: (input) =>
      resolveGeneration(registry, "generateBranchName", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
          textGeneration.generateBranchName({ ...input, modelSelection }),
        ),
      ),
    generateThreadTitle: (input) =>
      resolveGeneration(registry, "generateThreadTitle", input.modelSelection).pipe(
        Effect.flatMap(({ textGeneration, modelSelection }) =>
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
              modelSelection,
              linkedContext,
            });
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
