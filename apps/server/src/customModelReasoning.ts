import type {
  CustomModel,
  CustomModelConnection,
  ModelReasoningMetadata,
} from "@t3tools/contracts";
import { customModelImageInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Redacted from "effect/Redacted";
import type { ResolvedModelConnection } from "./customModels.ts";
import { makeModelReasoningResolver } from "./modelReasoning.ts";

/** Explicit setup only. Derived evidence is persisted separately from user overrides. */
export function makeCustomModelReasoning(resolver = makeModelReasoningResolver()) {
  const enrich = (
    connection: ResolvedModelConnection,
    previous?: CustomModelConnection,
    cachedOnly = false,
    refreshModelId?: string,
  ) =>
    Effect.gen(function* () {
      const models = yield* Effect.forEach(
        connection.models,
        (model) =>
          Effect.gen(function* () {
            const { reasoningMetadata: _untrusted, ...saved } = model;
            const input = {
              baseUrl: connection.baseUrl,
              protocol: connection.protocol,
              modelId: model.modelId,
              ...(connection.credentialId ? { credentialId: connection.credentialId } : {}),
              ...(connection.apiKey ? { apiKey: Redacted.value(connection.apiKey) } : {}),
            };
            let discovered =
              !model.reasoningOverride ||
              model.configurationMode === "automatic" ||
              customModelImageInput(model) === "automatic"
                ? cachedOnly
                  ? resolver.peek(input)
                  : yield* Effect.promise(() =>
                      resolver.resolve(input, refreshModelId === model.id),
                    )
                : undefined;
            // The caller supplies previous only for the same endpoint/protocol/credential.
            // Never reuse a different model's evidence, nor turn a manual claim into discovery.
            const previousModel = previous?.models.find(
              (entry) => entry.id === model.id && entry.modelId === model.modelId,
            );
            const prior = previousModel?.reasoningMetadata;
            if (
              discovered?.status === "unknown" &&
              prior?.source === "manual" &&
              (previousModel?.configurationMode === "automatic" ||
                (previousModel && customModelImageInput(previousModel) === "automatic"))
            ) {
              // The old reasoning assertion is not discovery. Its automatic capacity remains
              // independently reusable even if the user removes or changes that assertion.
              discovered = {
                ...discovered,
                ...(prior.contextWindow !== undefined && discovered.contextWindow === undefined
                  ? { contextWindow: prior.contextWindow }
                  : {}),
                ...(prior.maxOutputTokens !== undefined && discovered.maxOutputTokens === undefined
                  ? { maxOutputTokens: prior.maxOutputTokens }
                  : {}),
                ...(prior.images !== undefined && discovered.images === undefined
                  ? { images: prior.images }
                  : {}),
                stale: true,
              };
            }
            if (
              discovered?.status === "unknown" &&
              prior &&
              prior.source !== "manual" &&
              (prior.status === "known" ||
                prior.contextWindow !== undefined ||
                prior.maxOutputTokens !== undefined ||
                prior.images !== undefined)
            ) {
              discovered = {
                ...prior,
                ...(discovered.contextWindow !== undefined
                  ? { contextWindow: discovered.contextWindow }
                  : {}),
                ...(discovered.maxOutputTokens !== undefined
                  ? { maxOutputTokens: discovered.maxOutputTokens }
                  : {}),
                ...(discovered.images !== undefined ? { images: discovered.images } : {}),
                stale: true,
                detail: "Model metadata could not be verified; retaining previous evidence.",
              };
            }
            let reasoningMetadata: ModelReasoningMetadata;
            if (model.reasoningOverride) {
              reasoningMetadata = {
                status: "known",
                source: "manual",
                checkedAt: DateTime.formatIso(yield* DateTime.now),
                stale: false,
                supported: model.reasoningOverride.supported,
                // Manual controls declare effort semantics, never an implicit token budget.
                mode: connection.protocol === "anthropic-messages" ? "adaptive" : "effort",
                levels: [...model.reasoningOverride.levels],
                ...(model.reasoningOverride.defaultLevel
                  ? { defaultLevel: model.reasoningOverride.defaultLevel }
                  : {}),
                detail: "User-configured capabilities; not verified by the provider.",
              };
              // A reasoning override does not override independently resolved model capacity.
              if (discovered)
                reasoningMetadata = {
                  ...reasoningMetadata,
                  stale: discovered.stale,
                  ...(discovered.contextWindow !== undefined
                    ? { contextWindow: discovered.contextWindow }
                    : {}),
                  ...(discovered.maxOutputTokens !== undefined
                    ? { maxOutputTokens: discovered.maxOutputTokens }
                    : {}),
                  ...(discovered.images !== undefined ? { images: discovered.images } : {}),
                };
            } else {
              reasoningMetadata = discovered!;
            }
            return { ...saved, reasoningMetadata } satisfies CustomModel;
          }),
        { concurrency: 4 },
      );
      return { ...connection, models };
    });
  const prepare = (
    connection: ResolvedModelConnection,
    previous?: CustomModelConnection,
    refreshModelId?: string,
  ) =>
    enrich(connection, previous, connection.credentialError !== undefined, refreshModelId).pipe(
      // Bound the whole save, not N sequential per-model deadlines.
      Effect.timeout(Duration.millis(4000)),
      Effect.catchTag("TimeoutError", () => enrich(connection, previous, true)),
    );
  return { prepare };
}
