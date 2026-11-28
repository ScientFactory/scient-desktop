import {
  // SCIENT-FORK:START — Scient Accounts: a generator's key can name an Accounts key.
  referencedAccountId,
  // SCIENT-FORK:END
  type ListTextGeneratorModelsInput,
  type ListTextGeneratorModelsResult,
  type ProviderInstanceId,
  TextGenerationError,
  type TextGeneratorConfig,
  TextGeneratorError,
  type TextGeneratorModel,
  textGeneratorForSelection,
} from "@t3tools/contracts";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
// SCIENT-FORK:START — Scient Accounts: Accounts keys are absent where Accounts isn't built.
import * as Option from "effect/Option";
// SCIENT-FORK:END
import * as Ref from "effect/Ref";
import { FetchHttpClient, HttpClient } from "effect/http";

// SCIENT-FORK:START — Scient Accounts: a generator's key can name an Accounts key.
import * as TextGeneratorKeys from "../scient/accounts/textGeneratorKeys.ts";
// SCIENT-FORK:END
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import {
  TEXT_GENERATOR_DRIVERS,
  type TextGeneratorConnection,
  TextGeneratorRequestError,
} from "./textGeneratorDrivers.ts";

/** Text generators configured in settings: model APIs that generate text but cannot run agents. */
export class TextGenerators extends Context.Service<
  TextGenerators,
  {
    /** The runner for a text generator id, or undefined when the id names no text generator. */
    readonly runner: (
      id: ProviderInstanceId,
    ) => Effect.Effect<TextGenerationOperations.Runner | undefined>;
    readonly listModels: (
      input: ListTextGeneratorModelsInput,
    ) => Effect.Effect<ListTextGeneratorModelsResult, TextGeneratorError>;
  }
>()("t3/textGeneration/TextGenerators") {}

interface CachedModels {
  readonly config: TextGeneratorConfig;
  readonly models: ReadonlyArray<TextGeneratorModel>;
  // SCIENT-FORK: the key a typed key Accounts kept read; its row can change under one config.
  readonly kept?: string | undefined;
}

/** The generator's name for messages: its label, else the host it reaches. */
const generatorLabel = (config: TextGeneratorConfig) => {
  if (config.label) return config.label;
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return "The model API";
  }
};

/** @public */
export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  // SCIENT-FORK:START — Scient Accounts: a generator's key can name an Accounts key.
  const accountKeys = yield* Effect.serviceOption(TextGeneratorKeys.TextGeneratorKeys);
  // SCIENT-FORK:END
  const http = yield* HttpClient.HttpClient;
  const modelCache = yield* Ref.make(new Map<ProviderInstanceId, CachedModels>());
  // Settings already drop saved generators under an allow-list; this stops unsaved ones too.
  const allowListed =
    settingsService.managedPolicy?.limits?.providers?.allowedDrivers !== undefined;

  const readConfig = Effect.fn("TextGenerators.readConfig")(function* (id: ProviderInstanceId) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new TextGeneratorRequestError({ detail: "Couldn't read this environment's settings." }),
      ),
    );
    return textGeneratorForSelection(settings, id);
  });

  const connect = Effect.fn("TextGenerators.connect")(function* (
    config: TextGeneratorConfig,
    // SCIENT-FORK: Scient Accounts names the generator using an Accounts key.
    id: ProviderInstanceId,
  ) {
    const label = generatorLabel(config);
    // SCIENT-FORK:START — Scient Accounts: read an Accounts key for this generator's endpoint.
    const accountId = referencedAccountId(config.apiKey);
    const apiKey =
      accountId !== undefined
        ? yield* (
            Option.isSome(accountKeys)
              ? accountKeys.value.read(accountId, { ...config, id })
              : Effect.fail(TextGeneratorKeys.ACCOUNTS_UNAVAILABLE)
          ).pipe(Effect.mapError((detail) => new TextGeneratorRequestError({ detail })))
        : typeof config.apiKey === "string" && config.apiKey.trim() && Option.isSome(accountKeys)
          ? (yield* accountKeys.value
              .kept({ ...config, id }, config.apiKey)
              .pipe(Effect.mapError((detail) => new TextGeneratorRequestError({ detail })))).key
          : yield* requireSettingsSecret(secrets, config.apiKey).pipe(
              Effect.mapError(
                (cause) => new TextGeneratorRequestError({ detail: cause.message, cause }),
              ),
            );
    // SCIENT-FORK:END
    return { baseUrl: config.baseUrl, apiKey, label } satisfies TextGeneratorConnection;
  });

  // SCIENT-FORK:START — Scient Accounts: the API's answer to an Accounts key shows on that use.
  // Only a generation is proof the key works, and only a 401 says the key itself was refused.
  const reportKey =
    (config: TextGeneratorConfig, id: ProviderInstanceId, sent: string) =>
    <A, R>(effect: Effect.Effect<A, TextGeneratorRequestError, R>) => {
      if (Option.isNone(accountKeys) || !sent) return effect;
      const use = { ...config, id };
      return effect.pipe(
        Effect.tap(() => Effect.exit(accountKeys.value.report(use, sent, "ok"))),
        Effect.tapError((error) =>
          error.status === 401
            ? Effect.exit(accountKeys.value.report(use, sent, "refused"))
            : Effect.void,
        ),
      );
    };
  // SCIENT-FORK:END

  const runnerFor =
    (config: TextGeneratorConfig): TextGenerationOperations.Runner =>
    (request) => {
      const driver = TEXT_GENERATOR_DRIVERS[config.kind];
      const label = generatorLabel(config);
      return connect(config, request.modelSelection.instanceId).pipe(
        Effect.flatMap((connection) =>
          driver
            .generate(
              connection,
              request.modelSelection.model,
              request.prompt,
              request.structuredCorrection === "initial"
                ? toJsonSchemaObject(request.outputSchema)
                : undefined,
            )
            .pipe(
              // SCIENT-FORK: Scient Accounts records the API's answer to an Accounts key.
              reportKey(config, request.modelSelection.instanceId, connection.apiKey),
            ),
        ),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError(
          (error) =>
            new TextGenerationError({
              operation: request.operation,
              detail: error.detail,
              cause: error,
            }),
        ),
        Effect.flatMap((text) => TextGenerationOperations.decodeJsonReply(request, label, text)),
      );
    };

  const runner = Effect.fn("TextGenerators.runner")(function* (id: ProviderInstanceId) {
    const config = yield* readConfig(id).pipe(Effect.orElseSucceed(() => undefined));
    if (config === undefined) return undefined;
    const label = generatorLabel(config);
    if (!config.enabled) {
      return ((request) =>
        Effect.fail(
          new TextGenerationError({
            operation: request.operation,
            detail: `${label} is off. Turn it on in Settings → Providers.`,
          }),
        )) satisfies TextGenerationOperations.Runner;
    }
    return TextGenerationOperations.withoutInvestigation(label, runnerFor(config));
  });

  const listModels = Effect.fn("TextGenerators.listModels")(
    function* (input: ListTextGeneratorModelsInput) {
      if (allowListed) {
        return yield* new TextGeneratorRequestError({
          detail: "Your organization's provider policy turns off text generators.",
        });
      }
      const saved = yield* readConfig(input.id);
      const config =
        input.config === undefined
          ? saved
          : input.config.apiKey === SECRET_REDACTED
            ? // The saved key goes only to the endpoint it was saved for.
              {
                ...input.config,
                apiKey: saved?.baseUrl === input.config.baseUrl ? saved.apiKey : "",
              }
            : input.config;
      if (config === undefined) {
        return yield* new TextGeneratorRequestError({
          detail: "That text generator no longer exists.",
        });
      }
      // Checking unsaved settings, or testing, must reach the API rather than trust the cache.
      const fresh = input.config !== undefined || input.test === true;
      const cached = (yield* Ref.get(modelCache)).get(input.id);
      // SCIENT-FORK:START — Scient Accounts: a kept typed key reads its row, which can change.
      const kept =
        typeof config.apiKey === "string" && config.apiKey.trim() && Option.isSome(accountKeys)
          ? yield* connect(config, input.id)
          : undefined;
      // SCIENT-FORK:END
      // Keyed on the whole config so a changed URL or key never serves another API's list.
      if (
        !fresh &&
        input.refresh !== true &&
        cached !== undefined &&
        Equal.equals(cached.config, config) &&
        // SCIENT-FORK: an Accounts key can be replaced or removed while the config stays the same.
        referencedAccountId(config.apiKey) === undefined &&
        cached.kept === kept?.apiKey
      ) {
        return { models: cached.models };
      }
      // SCIENT-FORK: Scient Accounts reads a kept typed key once.
      const connection = kept ?? (yield* connect(config, input.id));
      const driver = TEXT_GENERATOR_DRIVERS[config.kind];
      const models = yield* driver
        .listModels(connection)
        .pipe(Effect.provideService(HttpClient.HttpClient, http));
      if (input.test === true) {
        // An explicit test sends one tiny request: some APIs list models without checking the key.
        const model =
          input.model ??
          (models.find((candidate) => /haiku|mini|flash|nano/i.test(candidate.id)) ?? models[0])
            ?.id;
        if (model === undefined) {
          return yield* new TextGeneratorRequestError({
            detail: `${connection.label} lists no models to test with.`,
          });
        }
        yield* driver.generate(connection, model, "Reply with OK.").pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          // SCIENT-FORK: Scient Accounts records the API's answer to an Accounts key.
          reportKey(config, input.id, connection.apiKey),
        );
        return { models, testedModel: model };
      }
      yield* Ref.update(modelCache, (current) =>
        // SCIENT-FORK: Scient Accounts keys the list on a kept typed key's value too.
        new Map(current).set(input.id, { config, models, kept: kept?.apiKey }),
      );
      return { models };
    },
    Effect.mapError((error) => new TextGeneratorError({ detail: error.detail })),
  );

  return TextGenerators.of({ runner, listModels });
});

export const layer = Layer.effect(TextGenerators, make).pipe(
  Layer.provide([
    SecretResolverLayer.layer,
    FetchHttpClient.layer,
    // SCIENT-FORK:START — Scient Accounts: the same instance Accounts serves (`serveLayer`).
    TextGeneratorKeys.layer,
    // SCIENT-FORK:END
  ]),
);
