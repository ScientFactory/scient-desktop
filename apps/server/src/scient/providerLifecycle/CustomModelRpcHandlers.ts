/**
 * Scient's custom model RPCs: saving and removing a model connection, and
 * testing it through the agent it is connected to.
 *
 * @module CustomModelRpcHandlers
 */
import {
  CustomModelError,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  supportsModelConnections,
  TextGenerationError,
  WS_METHODS,
  WsServerManagementRpcGroup,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as EffectAcpErrors from "effect-acp/errors";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type * as ServerConfig from "../../config.ts";
import { customModelProviderId } from "../../customModels.ts";
import { droidCustomModelId } from "../../provider/droid/DroidCustomModels.ts";
import { encodeOmpModelSlug } from "../../provider/omp/OmpModel.ts";
import { encodePiModelSlug } from "../../provider/pi/PiModel.ts";
import type * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import type * as ServerSettings from "../../serverSettings.ts";
import { droidToolGuardTestRefusal } from "../../textGeneration/DroidTextGeneration.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";

const isTextGenerationError = Schema.is(TextGenerationError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

const compactProviderError = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`;
};

const CUSTOM_MODEL_TEST_TIMEOUT_SECONDS = 45;

/** Names the agent the test ran through: its instance label, else the driver's name. */
const customModelTestFailure = (
  instance: { readonly driverKind: ProviderDriverKind; readonly displayName: string | undefined },
  cause: unknown,
) => {
  const agent =
    instance.displayName ?? PROVIDER_DISPLAY_NAMES[instance.driverKind] ?? instance.driverKind;
  if (Predicate.isTagged(cause, "TimeoutError"))
    return new CustomModelError({
      message: `${agent}: No response within ${CUSTOM_MODEL_TEST_TIMEOUT_SECONDS} s.`,
    });
  // Droid refuses to run without its tool blocking; say so for a Test, not for titles.
  const toolGuard = isTextGenerationError(cause) ? droidToolGuardTestRefusal(cause) : undefined;
  if (toolGuard !== undefined) return new CustomModelError({ message: `${agent}: ${toolGuard}` });
  if (isTextGenerationError(cause) && isAcpRequestError(cause.cause)) {
    const providerDetail = compactProviderError(cause.cause.data);
    if (providerDetail) return new CustomModelError({ message: `${agent}: ${providerDetail}` });
    const providerMessage = compactProviderError(cause.cause.errorMessage);
    if (providerMessage) return new CustomModelError({ message: `${agent}: ${providerMessage}` });
  }
  return new CustomModelError({
    message: `${agent} could not use this model. Check the key, model ID and model settings.`,
  });
};

export const makeCustomModelRpcHandlers = ({
  observeRpcEffect,
  serverSettings,
  providerInstances,
  config,
}: Pick<ScientRpcObservers, "observeRpcEffect"> & {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
  readonly config: ServerConfig.ServerConfig["Service"];
}) =>
  ({
    [WS_METHODS.serverSaveCustomModel]: (input) =>
      observeRpcEffect(WS_METHODS.serverSaveCustomModel, serverSettings.saveCustomModel(input), {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverRemoveCustomModel]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverRemoveCustomModel,
        serverSettings.removeCustomModel(input),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverTestCustomModel]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverTestCustomModel,
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          if (settings.customModels.revision !== input.revision)
            return yield* new CustomModelError({
              message: "Custom models changed. Test the updated configuration.",
            });
          const connection = settings.customModels.connections.find(
            (c) => c.id === input.connectionId,
          );
          const model = connection?.models.find((m) => m.id === input.modelId);
          const instance = yield* providerInstances.getInstance(input.instanceId);
          if (
            !connection ||
            !model ||
            !model.instanceIds.includes(input.instanceId) ||
            !instance?.enabled ||
            !supportsModelConnections(instance.driverKind, connection.protocol)
          )
            return yield* new CustomModelError({
              message:
                "Connect this model to an enabled Pi, Droid, Oh My Pi, or Scient agent first.",
            });
          const resolved = yield* serverSettings.resolveCustomModels(input.instanceId);
          const credentialError = resolved.find((c) => c.id === connection.id)?.credentialError;
          if (credentialError !== undefined)
            return yield* new CustomModelError({ message: credentialError });
          const slug =
            instance.driverKind === "droid"
              ? droidCustomModelId(connection.id, model.id)
              : instance.driverKind === "omp" || instance.driverKind === "scient"
                ? encodeOmpModelSlug(customModelProviderId(connection.id), model.modelId)
                : encodePiModelSlug(customModelProviderId(connection.id), model.modelId);
          if (!slug) return yield* new CustomModelError({ message: "Invalid model ID." });
          yield* instance.textGeneration
            .generateThreadTitle({
              cwd: config.cwd,
              message: "Connection test",
              modelSelection: createModelSelection(input.instanceId, slug),
            })
            .pipe(
              Effect.timeout(Duration.seconds(CUSTOM_MODEL_TEST_TIMEOUT_SECONDS)),
              Effect.mapError((cause) => customModelTestFailure(instance, cause)),
            );
          const latest = yield* serverSettings.getSettings;
          if (latest.customModels.revision !== input.revision)
            return yield* new CustomModelError({
              message: "Custom models changed during the test. Test again.",
            });
          return { revision: input.revision };
        }).pipe(
          Effect.catchTags({
            ServerSettingsError: () =>
              Effect.fail(new CustomModelError({ message: "Could not read custom models." })),
          }),
        ),
        { "rpc.aggregate": "server" },
      ),
  }) satisfies ScientRpcHandlerSubset<
    typeof WsServerManagementRpcGroup,
    | typeof WS_METHODS.serverSaveCustomModel
    | typeof WS_METHODS.serverRemoveCustomModel
    | typeof WS_METHODS.serverTestCustomModel
  >;
