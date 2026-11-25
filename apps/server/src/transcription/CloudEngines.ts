import { LegacySpeechKeys, legacySpeechDestinations } from "../speech/LegacySpeechKeys.ts";
// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off - Uses the transcription ledger's atomic configuration writer.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CloudEngineBindingFields,
  ProjectId,
  isSpeechAccountOrigin,
  type CloudDictationChoice,
  type SpeechKeyCandidate,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ScientServerSettings } from "../scientServerSettings.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import { AccountsService, SPEECH_KEY_OUTSIDE_PROJECT } from "../scient/accounts/AccountsService.ts";
import { isCloudResponseError, openCloudEngine } from "./cloud.ts";
import { atomicWrite } from "./ledger.ts";
import { sampleRate } from "./windows.ts";

const Provider = CloudEngineBindingFields.provider;
const OPENAI_ORIGIN = "https://api.openai.com";
const id = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
const configFields = {
  ...CloudEngineBindingFields,
  maxAudioBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(sampleRate * 2 + 44),
    Schema.isLessThanOrEqualTo(25_000_000),
  ),
};
const Config = Schema.Struct({
  id,
  ...configFields,
  uploadConsent: Schema.optionalKey(Schema.Boolean),
  migrated: Schema.optionalKey(Schema.Boolean),
});
type Config = typeof Config.Type;

export const Request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("add"),
    ...configFields,
    projectId: Schema.optionalKey(ProjectId),
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    id,
    ...configFields,
    projectId: Schema.optionalKey(ProjectId),
  }),
  Schema.Struct({ action: Schema.Literal("remove"), id }),
  Schema.Struct({ action: Schema.Literal("test"), id, projectId: Schema.optionalKey(ProjectId) }),
  Schema.Struct({ action: Schema.Literal("set-upload-consent"), id, allowed: Schema.Boolean }),
]);
type Request = typeof Request.Type;

export class CloudEngineError extends Schema.TaggedError<CloudEngineError>()("CloudEngineError", {
  code: Schema.Literals([
    "invalid-input",
    "not-found",
    "unavailable",
    "io",
    "consent-required",
    "provider-key-rejected",
    "key-not-available-in-project",
    "provider-response-too-large",
  ]),
  detail: Schema.String,
}) {}

const error = (code: CloudEngineError["code"], detail: string) =>
  new CloudEngineError({ code, detail });
const unavailable = () =>
  error("unavailable", "The cloud speech account or provider is unavailable.");
const consentRequired = () =>
  error("consent-required", "Allow audio uploads for this cloud engine first.");
const io = () => error("io", "Could not access cloud speech configuration.");

function endpoint(config: Config): URL | undefined {
  if (config.provider !== "compatible" && config.baseUrl !== undefined) return;
  switch (config.provider) {
    case "openai":
      return config.model === "gpt-transcribe"
        ? new URL("https://api.openai.com/v1/audio/transcriptions")
        : undefined;
    case "xai":
      return config.model === "grok-voice-transcribe-2.0"
        ? new URL("https://api.x.ai/v1/stt")
        : undefined;
    case "openrouter":
      return new URL("https://openrouter.ai/api/v1/audio/transcriptions");
    case "compatible": {
      if (!config.baseUrl || !URL.canParse(config.baseUrl)) return;
      const url = new URL(config.baseUrl);
      if (
        !isSpeechAccountOrigin(url.origin) ||
        (url.protocol === "http:" &&
          !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(config.baseUrl)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return;
      url.pathname = url.pathname.replace(/\/+$/, "") + "/audio/transcriptions";
      return url;
    }
  }
}

type Resolved = {
  provider: Config["provider"];
  model: string;
  accountName: string;
  origin: string;
  fingerprint: string;
  maxAudioBytes: number;
  open: (
    language: string,
    signal: AbortSignal,
    jobId: string,
  ) => ReturnType<typeof openCloudEngine>;
};

export class CloudEngines extends Context.Service<
  CloudEngines,
  {
    readonly execute: (
      request: Request,
    ) => Effect.Effect<readonly Config[] | Config | { ok: true }, CloudEngineError>;
    readonly describe?: (
      config: Config,
    ) => Effect.Effect<{ accountName?: string; origin?: string }, CloudEngineError>;
    readonly savedKeys: (
      origin: string,
    ) => Effect.Effect<readonly SpeechKeyCandidate[], CloudEngineError>;
    readonly listDictationChoices: Effect.Effect<readonly CloudDictationChoice[], CloudEngineError>;
    readonly chooseForDictation: (
      choice: Pick<CloudDictationChoice, "id" | "origin" | "model">,
    ) => Effect.Effect<void, CloudEngineError>;
    readonly resolve: (
      id: string,
      projectId?: ProjectId,
    ) => Effect.Effect<Resolved, CloudEngineError>;
    /**
     * The key of an OpenAI speech engine the user agreed to send audio to, for a spoken
     * conversation with OpenAI's realtime models; none without one.
     */
    readonly realtimeKey: (
      projectId?: ProjectId,
    ) => Effect.Effect<Redacted.Redacted<string> | undefined, CloudEngineError>;
  }
>()("t3/transcription/CloudEngines") {}

const decode = Schema.decodeUnknownEffect(Schema.Array(Config));

/** Read the atomically written engine bindings without resolving an account or opening a key. */
export function readCloudEngineConfigs(stateDir: string) {
  const path = NodePath.join(stateDir, "transcription-engines.json");
  return Effect.tryPromise({
    try: () =>
      NodeFSP.readFile(path, "utf8").catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return "[]";
        throw cause;
      }),
    catch: io,
  }).pipe(
    Effect.flatMap((contents) =>
      Effect.try({ try: () => JSON.parse(contents) as unknown, catch: io }),
    ),
    Effect.flatMap(decode),
    Effect.mapError(io),
  );
}

export const layer = Layer.effect(
  CloudEngines,
  Effect.gen(function* () {
    const accounts = yield* AccountsService;
    const legacy = yield* Effect.serviceOption(LegacySpeechKeys);
    const settings = yield* ServerSettingsService;
    const scient = yield* ScientServerSettings;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const { stateDir } = yield* ServerConfig;
    const path = NodePath.join(stateDir, "transcription-engines.json");
    const migrationPath = NodePath.join(stateDir, "transcription-legacy-keys.json");
    const mutex = yield* Semaphore.make(1);
    const readJson = (file: string) =>
      Effect.tryPromise({
        try: () =>
          NodeFSP.readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return "[]";
            throw cause;
          }),
        catch: io,
      }).pipe(
        Effect.flatMap((contents) =>
          Effect.try({ try: () => JSON.parse(contents) as unknown, catch: io }),
        ),
      );
    const read = readCloudEngineConfigs(stateDir);
    const readMigrated = readJson(migrationPath).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Provider))),
      Effect.mapError(io),
    );
    const write = (configs: readonly Config[]) =>
      Effect.tryPromise({
        try: () => atomicWrite(path, JSON.stringify(configs)),
        catch: io,
      });
    const resolveKey = Effect.fn("CloudEngines.resolveKey")(function* (
      config: Config,
      origin: string,
      usage?: { provider: Config["provider"]; jobId: string },
      projectId?: ProjectId,
    ) {
      if (config.accountId && config.customModelConnectionId) return yield* unavailable();
      const connection = config.customModelConnectionId
        ? scient
            .committedCustomModels()
            .connections.find(({ id }) => id === config.customModelConnectionId)
        : undefined;
      const accountId =
        config.accountId ??
        (connection &&
        URL.canParse(connection.baseUrl) &&
        new URL(connection.baseUrl).origin === origin
          ? connection.accountId
          : undefined);
      if (accountId) {
        return yield* accounts
          .resolveSpeechKey(accountId, origin, usage, projectId)
          .pipe(
            Effect.mapError((cause) =>
              cause.message === SPEECH_KEY_OUTSIDE_PROJECT
                ? error("key-not-available-in-project", SPEECH_KEY_OUTSIDE_PROJECT)
                : unavailable(),
            ),
          );
      }
      if (
        !config.accountId &&
        config.customModelConnectionId &&
        settings.resolveSpeechCustomModelKey
      ) {
        const key = yield* settings
          .resolveSpeechCustomModelKey(config.customModelConnectionId, origin)
          .pipe(Effect.mapError(unavailable));
        if (key) return key;
      }
      return yield* unavailable();
    });
    const savedKeys = Effect.fn("CloudEngines.savedKeys")(function* (origin: string) {
      if (!isSpeechAccountOrigin(origin)) return [];
      const snapshot = yield* accounts.snapshot;
      const current = yield* settings.getSettings;
      return [
        ...snapshot.accounts.flatMap((account): SpeechKeyCandidate[] => {
          const { details, secrets } = account;
          if (
            details.kind !== "api-key" ||
            details.auth.type !== "bearer" ||
            !details.sites.includes(origin) ||
            secrets.token?.source.type !== "scient"
          )
            return [];
          return [
            {
              id: account.accountId,
              kind: "account",
              label: account.name,
              origin,
              ...(secrets.token.hint ? { hint: secrets.token.hint } : {}),
            },
          ];
        }),
        ...current.customModels.connections.flatMap((item): SpeechKeyCandidate[] => {
          if (
            !item.credentialId ||
            !URL.canParse(item.baseUrl) ||
            new URL(item.baseUrl).origin !== origin
          )
            return [];
          return [
            {
              id: item.id,
              kind: "custom-model",
              label: item.name,
              origin,
              ...(item.apiKeySuffix ? { hint: item.apiKeySuffix } : {}),
            },
          ];
        }),
      ];
    }, Effect.mapError(io));
    const bind = Effect.fn("CloudEngines.bind")(function* (config: Config, projectId?: ProjectId) {
      const { uploadConsent: _, migrated: _migrated, ...binding } = config;
      const digest = (value: typeof binding) =>
        NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const fingerprint = digest(binding);
      const url = endpoint(config);
      if (!url) return yield* error("invalid-input", "Invalid cloud speech endpoint or model.");
      const { name, token } = yield* resolveKey(config, url.origin, undefined, projectId);
      const secret = Redacted.value(token);
      if (!secret || config.model.includes(secret) || config.baseUrl?.includes(secret))
        return yield* error("invalid-input", "Invalid cloud speech configuration.");
      return {
        provider: config.provider,
        model: config.model,
        accountName: name.replaceAll(secret, "[redacted]"),
        maxAudioBytes: config.maxAudioBytes,
        origin: url.origin,
        fingerprint,
        open: (language: string, signal: AbortSignal, jobId: string) =>
          openCloudEngine(
            {
              ...config,
              endpoint: url,
              language,
              onRetry: (reason) =>
                run(
                  Effect.logWarning("Retrying cloud transcription window", {
                    provider: config.provider,
                    jobId,
                    reason,
                  }),
                ),
            },
            async (attemptSignal) => {
              const outcome = await run(
                Effect.gen(function* () {
                  if (jobId !== "connection-test") {
                    const current = (yield* read).find((entry) => entry.id === config.id);
                    if (!current?.uploadConsent) return yield* consentRequired();
                    const { uploadConsent: _, migrated: _migrated, ...currentBinding } = current;
                    if (digest(currentBinding) !== fingerprint) return yield* consentRequired();
                  }
                  const { token } = yield* resolveKey(
                    config,
                    url.origin,
                    {
                      provider: config.provider,
                      jobId,
                    },
                    projectId,
                  );
                  return Redacted.value(token);
                }).pipe(Effect.result),
                { signal: attemptSignal },
              );
              if (outcome._tag === "Failure") throw outcome.failure;
              return outcome.success;
            },
            signal,
          ),
      } satisfies Resolved;
    });
    const find = (configs: readonly Config[], id: string) =>
      Effect.fromNullishOr(configs.find((config) => config.id === id)).pipe(
        Effect.mapError(() => error("not-found", "Cloud speech engine was not found.")),
      );
    const resolve = Effect.fn("CloudEngines.resolve")(function* (
      id: string,
      requireConsent = true,
      projectId?: ProjectId,
    ) {
      const config = yield* find(yield* read, id);
      if (requireConsent && !config.uploadConsent) return yield* consentRequired();
      return yield* bind(config, projectId);
    });
    const execute = Effect.fn("CloudEngines.execute")(function* (request: Request) {
      if (request.action === "test") {
        const bound = yield* resolve(request.id, false, request.projectId);
        return yield* Effect.tryPromise({
          try: async (signal): Promise<{ ok: true }> => {
            const recognizer = bound.open("auto", signal, "connection-test");
            await recognizer.recognize(new Float32Array(sampleRate), false);
            return { ok: true };
          },
          catch: (cause) => {
            if (isCloudResponseError(cause)) {
              if (cause.code === "provider-key-rejected")
                return error(cause.code, "The provider rejected the speech key.");
              if (cause.code === "provider-response-too-large")
                return error(cause.code, "The provider response exceeded the size limit.");
            }
            return unavailable();
          },
        });
      }
      return yield* mutex.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const configs = yield* read;
            if (request.action === "list") return configs;
            if (request.action === "remove") {
              yield* find(configs, request.id);
              yield* write(configs.filter((config) => config.id !== request.id));
              return { ok: true } as const;
            }
            if (request.action === "set-upload-consent") {
              const current = yield* find(configs, request.id);
              const config = { ...current, uploadConsent: request.allowed };
              yield* write(configs.map((entry) => (entry.id === config.id ? config : entry)));
              return config;
            }
            if (request.action === "update") yield* find(configs, request.id);
            if (request.action !== "add" && request.action !== "update")
              return yield* error("invalid-input", "Invalid cloud speech command.");
            const { action, projectId, ...fields } = request;
            const config = {
              ...fields,
              id: action === "add" ? NodeCrypto.randomUUID() : request.id,
            };
            yield* bind(config, projectId);
            yield* write([...configs.filter((entry) => entry.id !== config.id), config]);
            return config;
          }),
        ),
      );
    });
    const describe = Effect.fn("CloudEngines.describe")(function* (config: Config) {
      const snapshot = yield* accounts.snapshot.pipe(Effect.mapError(unavailable));
      const account = snapshot.accounts.find((entry) => entry.accountId === config.accountId);
      const origin = endpoint(config)?.origin;
      return { ...(account ? { accountName: account.name } : {}), ...(origin ? { origin } : {}) };
    });
    const listDictationChoices = mutex.withPermit(
      Effect.gen(function* () {
        const configs = [...(yield* read)];
        const migrated = new Set(yield* readMigrated);
        const pending: CloudDictationChoice[] = [];
        if (legacy._tag === "Some") {
          for (const provider of ["openai", "xai", "openrouter"] as const) {
            const source = yield* legacy.value
              .get(provider)
              .pipe(Effect.orElseSucceed(() => "" as const));
            if (typeof source !== "object" || !("accountId" in source)) continue;
            const { accountId } = source;
            const { model, origin } = legacySpeechDestinations[provider];
            if (!model) {
              if (
                !configs.some(
                  (config) => config.provider === provider && config.accountId === accountId,
                )
              ) {
                pending.push({
                  id: "legacy-openrouter",
                  model: "",
                  origin,
                  provider,
                  migrated: true,
                  needsModel: true,
                });
              }
              continue;
            }
            if (migrated.has(provider)) continue;
            if (
              !configs.some(
                (config) =>
                  config.provider === provider &&
                  config.accountId === accountId &&
                  config.model === model,
              )
            ) {
              configs.push({
                id: NodeCrypto.randomUUID(),
                provider,
                model,
                accountId,
                migrated: true,
                maxAudioBytes: 25_000_000,
              });
              yield* write(configs);
            }
            migrated.add(provider);
            yield* Effect.tryPromise({
              try: () => atomicWrite(migrationPath, JSON.stringify([...migrated])),
              catch: io,
            });
          }
        }
        const customModels = scient.committedCustomModels().connections;
        const accountSnapshot = yield* accounts.snapshot.pipe(Effect.mapError(io));
        return [
          ...configs.flatMap((config) => {
            const url = endpoint(config);
            if (!url) return [];
            const custom = customModels.find(({ id }) => id === config.customModelConnectionId);
            const account = accountSnapshot.accounts.find(
              ({ accountId }) => accountId === (config.accountId ?? custom?.accountId),
            );
            const validAccount =
              account?.details.kind === "api-key" &&
              account.details.auth.type === "bearer" &&
              account.details.sites.includes(url.origin) &&
              account.secrets.token?.source.type === "scient";
            const validCustom =
              custom?.credentialId &&
              URL.canParse(custom.baseUrl) &&
              new URL(custom.baseUrl).origin === url.origin;
            const keyLabel = account?.name ?? custom?.name;
            return [
              {
                id: config.id,
                origin: url.origin,
                model: config.model,
                provider: config.provider,
                uploadConsent: config.uploadConsent === true,
                ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
                ...(config.customModelConnectionId
                  ? { customModelConnectionId: config.customModelConnectionId }
                  : {}),
                ...(keyLabel ? { keyLabel } : {}),
                ...(config.migrated ? { migrated: true } : {}),
                ...(!(validAccount || validCustom) ? { reconnect: true } : {}),
              },
            ];
          }),
          ...pending,
        ];
      }),
    );
    const chooseForDictation: CloudEngines["Service"]["chooseForDictation"] = ({
      id,
      origin,
      model,
    }) =>
      mutex.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const configs = yield* read;
            const config = yield* find(configs, id);
            const bound = yield* bind(config);
            if (bound.origin !== origin || bound.model !== model) {
              return yield* error(
                "invalid-input",
                "This speech engine changed. Review its current settings.",
              );
            }
            yield* write(
              configs.map((item) => (item.id === id ? { ...item, uploadConsent: true } : item)),
            );
          }),
        ),
      );
    const realtimeKey = Effect.fn("CloudEngines.realtimeKey")(function* (projectId?: ProjectId) {
      const config = (yield* read).find(
        (entry) => entry.provider === "openai" && entry.uploadConsent,
      );
      if (!config) return undefined;
      const { token } = yield* resolveKey(
        config,
        OPENAI_ORIGIN,
        { provider: "openai", jobId: "lesson-talk" },
        projectId,
      );
      return token;
    });
    return CloudEngines.of({
      execute,
      realtimeKey,
      resolve: Effect.fn("CloudEngines.resolveForProject")((id, projectId) =>
        resolve(id, true, projectId),
      ),
      listDictationChoices,
      chooseForDictation,
      savedKeys,
      describe,
    });
  }),
);
