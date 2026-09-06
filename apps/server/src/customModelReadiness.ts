import {
  customModelAttachmentKey,
  type ModelConnectionReadiness,
  type CustomModel,
} from "@t3tools/contracts";
import type { ResolvedModelConnection } from "./customModels.ts";

/** Discovery proves configuration availability, never paid inference or account access. */
export function assessModelConnections(
  connections: ReadonlyArray<ResolvedModelConnection>,
  available: (
    connection: ResolvedModelConnection,
    model: CustomModel,
  ) =>
    | {
        contextWindow?: number | undefined;
        maxOutputTokens?: number | undefined;
        source?: ModelConnectionReadiness["source"];
      }
    | undefined,
): ReadonlyArray<ModelConnectionReadiness> {
  return connections.flatMap((connection) =>
    connection.models.map((model) => {
      const resolved =
        connection.credentialError === undefined ? available(connection, model) : undefined;
      return {
        connectionId: connection.id,
        modelId: model.id,
        configurationKey: customModelAttachmentKey(connection, model),
        state: resolved ? "available" : "needs_setup",
        ...(resolved
          ? {
              ...(resolved.contextWindow === undefined
                ? {}
                : { contextWindow: resolved.contextWindow }),
              ...(resolved.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: resolved.maxOutputTokens }),
              ...(resolved.source === undefined ? {} : { source: resolved.source }),
            }
          : { reason: connection.credentialError ? "credential" : "model_unavailable" }),
      } satisfies ModelConnectionReadiness;
    }),
  );
}
