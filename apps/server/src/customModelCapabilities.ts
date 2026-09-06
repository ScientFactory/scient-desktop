import type {
  CustomModel,
  CustomModelConnection,
  CustomModelProtocol,
  ModelReasoningMetadata,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

/** Compare the authority actually loaded by a process, not the global catalog revision. */
export function customModelRuntimeChange(
  loaded: ReadonlyArray<CustomModelConnection>,
  current: ReadonlyArray<CustomModelConnection>,
  instanceId: ProviderInstanceId,
): "unchanged" | "refresh" | "revoke" {
  const before = customModelDiscoverySnapshot(loaded, instanceId);
  const after = customModelDiscoverySnapshot(current, instanceId);
  for (const connection of before) {
    const next = after.find((entry) => entry.id === connection.id);
    if (
      !next ||
      next.credentialId !== connection.credentialId ||
      next.baseUrl !== connection.baseUrl ||
      next.protocol !== connection.protocol ||
      connection.models.some(
        (model) =>
          !next.models.some((entry) => entry.id === model.id && entry.modelId === model.modelId),
      )
    )
      return "revoke";
  }
  const transport = (snapshot: typeof before) =>
    snapshot.map(({ name: _name, models, ...connection }) => ({
      ...connection,
      models: models.map(({ name: _label, defaultReasoningLevel: _preference, ...model }) => model),
    }));
  return Equal.equals(transport(before), transport(after)) ? "unchanged" : "refresh";
}

export type CustomModelReasoning = Pick<
  ModelReasoningMetadata,
  "status" | "supported" | "levels" | "defaultLevel" | "mode"
>;

/** Explicit intent wins without requiring a persisted discovery snapshot. */
export function effectiveCustomModelReasoning(
  model: CustomModel,
  protocol: CustomModelProtocol,
): CustomModelReasoning | undefined {
  if (model.reasoningOverride) {
    return {
      status: "known",
      ...model.reasoningOverride,
      mode: protocol === "anthropic-messages" ? "adaptive" : "effort",
    };
  }
  const metadata = model.reasoningMetadata;
  return metadata
    ? {
        status: metadata.status,
        supported: metadata.supported,
        levels: metadata.levels,
        ...(metadata.defaultLevel === undefined ? {} : { defaultLevel: metadata.defaultLevel }),
        ...(metadata.mode === undefined ? {} : { mode: metadata.mode }),
      }
    : undefined;
}

/** Discovery reacts only to this instance's configuration, never evidence timestamps or secrets. */
export function customModelDiscoverySnapshot(
  connections: ReadonlyArray<CustomModelConnection>,
  instanceId: ProviderInstanceId,
) {
  return connections.flatMap((connection) => {
    const models = connection.models
      .filter((model) => model.instanceIds.includes(instanceId))
      .map((model) => ({
        id: model.id,
        modelId: model.modelId,
        name: model.name,
        configurationMode: model.configurationMode,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        images: model.images,
        imageInput: model.imageInput,
        reasoning: model.reasoning,
        defaultReasoningLevel: model.defaultReasoningLevel,
        reasoningOverride: model.reasoningOverride,
        reasoningMetadata: {
          ...effectiveCustomModelReasoning(model, connection.protocol),
          contextWindow: model.reasoningMetadata?.contextWindow,
          maxOutputTokens: model.reasoningMetadata?.maxOutputTokens,
          images: model.reasoningMetadata?.images,
        },
      }));
    return models.length
      ? [
          {
            id: connection.id,
            name: connection.name,
            protocol: connection.protocol,
            baseUrl: connection.baseUrl,
            credentialId: connection.credentialId,
            models,
          },
        ]
      : [];
  });
}
