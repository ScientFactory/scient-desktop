import {
  AccountId,
  type CloudSpeechProvider,
  type SecretReference,
  type ServerSettings,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Redacted, Semaphore } from "effect";
import { CloudSpeechError } from "@t3tools/contracts";
import { AccountsService } from "../scient/accounts/AccountsService.ts";
import { ServerSettingsService } from "../serverSettings.ts";

export const legacySpeechDestinations = {
  openai: { origin: "https://api.openai.com", model: "gpt-transcribe" },
  xai: { origin: "https://api.x.ai", model: "grok-voice-transcribe-2.0" },
  openrouter: { origin: "https://openrouter.ai", model: null },
} as const;

export type LegacySpeechSource = string | SecretReference | { readonly accountId: AccountId };

export class LegacySpeechKeys extends Context.Service<
  LegacySpeechKeys,
  {
    readonly get: (
      provider: CloudSpeechProvider,
    ) => Effect.Effect<LegacySpeechSource, CloudSpeechError>;
    readonly hasKey: (provider: CloudSpeechProvider) => Effect.Effect<boolean, CloudSpeechError>;
    readonly key: (
      provider: CloudSpeechProvider,
      accountId: AccountId,
    ) => Effect.Effect<Redacted.Redacted<string>, CloudSpeechError>;
    readonly set: (
      provider: CloudSpeechProvider,
      key: Redacted.Redacted<string> | SecretReference | null,
    ) => Effect.Effect<void, CloudSpeechError>;
  }
>()("t3/speech/LegacySpeechKeys") {}

export const layer = Layer.effect(
  LegacySpeechKeys,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const accounts = yield* AccountsService;
    const mutex = yield* Semaphore.make(1);
    const unreadable = (provider: CloudSpeechProvider) =>
      new CloudSpeechError({ provider, reason: "unreadable-key" });
    const key = (provider: CloudSpeechProvider, accountId: AccountId) =>
      accounts.resolveSpeechKey(accountId, legacySpeechDestinations[provider].origin).pipe(
        Effect.map(({ token }) => token),
        Effect.mapError((error) =>
          error.reason === "not-found"
            ? new CloudSpeechError({ provider, reason: "missing-key" })
            : unreadable(provider),
        ),
      );

    const hasKey = Effect.fn("LegacySpeechKeys.hasKey")(function* (provider: CloudSpeechProvider) {
      const failed = () => unreadable(provider);
      const current = yield* settings.getSettings.pipe(Effect.mapError(failed));
      const source = current.cloudSpeechCredentials[provider];
      const accountId = current.legacySpeechAccountIds?.[provider];
      if (typeof source !== "string") return true;
      if (!accountId) return Boolean(source.trim());
      const snapshot = yield* accounts.snapshot.pipe(Effect.mapError(failed));
      return snapshot.accounts.some(
        (account) =>
          account.accountId === accountId &&
          account.details?.kind === "api-key" &&
          account.details.auth.type === "bearer" &&
          account.details.sites.includes(legacySpeechDestinations[provider].origin) &&
          account.secrets.token?.source.type === "scient",
      );
    });

    const transfer = Effect.fn("LegacySpeechKeys.transfer")(function* (
      provider: CloudSpeechProvider,
      current: ServerSettings,
      token: Redacted.Redacted<string>,
    ) {
      const commit = settings.commitLegacySpeechTransfer;
      if (!commit || !accounts.saveLegacySpeechKey) return yield* unreadable(provider);
      // Slot identity belongs to this server. A retry opens the same record even if publication
      // of the settings reference was interrupted after the vault write.
      const accountId =
        current.legacySpeechAccountIds?.[provider] ??
        AccountId.make(`acc_legacy_speech_${provider}`);
      const failed = () => unreadable(provider);
      yield* accounts
        .saveLegacySpeechKey(
          accountId,
          legacySpeechDestinations[provider].origin,
          `Speech · ${provider}`,
          token,
        )
        .pipe(Effect.mapError(failed));
      const verified = yield* key(provider, accountId);
      if (Redacted.value(verified) !== Redacted.value(token)) return yield* failed();
      yield* commit(provider, current.cloudSpeechCredentials[provider], accountId).pipe(
        Effect.mapError(failed),
      );
      return { accountId };
    });

    const get = (provider: CloudSpeechProvider) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const current = yield* settings.getSettings.pipe(
            Effect.mapError(() => unreadable(provider)),
          );
          const source = current.cloudSpeechCredentials[provider];
          if (typeof source !== "string") return source;
          const accountId = current.legacySpeechAccountIds?.[provider];
          if (accountId) {
            if (source.trim() && settings.commitLegacySpeechTransfer) {
              // Resume retirement after a restart without restoring the old key to Accounts.
              yield* settings
                .commitLegacySpeechTransfer(provider, source, accountId)
                .pipe(Effect.mapError(() => unreadable(provider)));
            }
            return { accountId };
          }
          return source.trim()
            ? yield* Effect.uninterruptible(transfer(provider, current, Redacted.make(source)))
            : "";
        }),
      );

    const set = (
      provider: CloudSpeechProvider,
      next: Redacted.Redacted<string> | SecretReference | null,
    ) =>
      mutex.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* settings.getSettings.pipe(
              Effect.mapError(() => unreadable(provider)),
            );
            if (Redacted.isRedacted(next)) {
              yield* transfer(provider, current, next);
              return;
            }
            if (next || typeof current.cloudSpeechCredentials[provider] !== "string") {
              if (!settings.replaceLegacySpeechReference) return yield* unreadable(provider);
              yield* settings
                .replaceLegacySpeechReference(provider, next ?? "")
                .pipe(Effect.mapError(() => unreadable(provider)));
              return;
            }
            const accountId = current.legacySpeechAccountIds?.[provider];
            if (
              !next &&
              accountId &&
              typeof current.cloudSpeechCredentials[provider] === "string"
            ) {
              yield* accounts.remove(accountId).pipe(
                Effect.catchIf(
                  (error) => error.reason === "not-found",
                  () => Effect.void,
                ),
                Effect.mapError(() => unreadable(provider)),
              );
            }
            yield* settings
              .updateSettings({ cloudSpeechCredentials: { [provider]: next ?? "" } })
              .pipe(Effect.mapError(() => unreadable(provider)));
          }),
        ),
      );

    return LegacySpeechKeys.of({ get, hasKey, key, set });
  }),
);
