// @effect-diagnostics nodeBuiltinImport:off -- Native keyring and metadata-only OS commands are lazy adapters.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import {
  AccountsError,
  BUILT_IN_BROWSER_PROFILES,
  type BrowserProfileId,
  type AccountCustomModelKey,
  type AccountValueSource,
  type OnePasswordConnectInput,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Redacted } from "effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { resolveCustomModelKey } from "../../customModels.ts";
import {
  parseMacKeychain,
  parseWindowsKeychain,
  selectKeychainCandidates,
} from "./KeychainCandidates.ts";

const requireKeyring = NodeModule.createRequire(import.meta.url);
const unavailable = (message: string) => new AccountsError({ reason: "unavailable", message });
export interface OnePasswordClient {
  readonly resolve: (reference: string) => Effect.Effect<Redacted.Redacted<string>, AccountsError>;
  readonly label: string;
}

export class AccountSources extends Context.Service<
  AccountSources,
  {
    readonly platform: "macos" | "windows" | "linux";
    readonly profiles: Effect.Effect<ReadonlyArray<BrowserProfileId>, AccountsError>;
    readonly customModelKeys: Effect.Effect<ReadonlyArray<AccountCustomModelKey>, AccountsError>;
    readonly keychain: (
      source: Extract<AccountValueSource, { type: "keychain" }>,
    ) => Effect.Effect<Redacted.Redacted<string>, AccountsError>;
    readonly customModel: (
      connectionId: string,
    ) => Effect.Effect<Redacted.Redacted<string>, AccountsError>;
    readonly onePassword: (
      input: Redacted.Redacted<OnePasswordConnectInput>,
    ) => Effect.Effect<OnePasswordClient, AccountsError>;
    readonly candidates: (query: string | undefined) => Effect.Effect<
      {
        listed: boolean;
        candidates: ReadonlyArray<import("@t3tools/contracts").KeychainCandidate>;
      },
      AccountsError
    >;
  }
>()("t3/scient/accounts/AccountSources") {}

export const layer = Layer.effect(
  AccountSources,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const secrets = yield* ServerSecretStore;
    const current = settings.getSettings.pipe(
      Effect.mapError(() => unavailable("Accounts settings could not be read.")),
    );
    const hostPlatform = yield* HostProcess.Platform;
    const platform =
      hostPlatform === "darwin" ? "macos" : hostPlatform === "win32" ? "windows" : "linux";
    return AccountSources.of({
      platform,
      profiles: Effect.succeed(BUILT_IN_BROWSER_PROFILES.map((profile) => profile.id)),
      customModelKeys: current.pipe(
        Effect.map((value) =>
          value.customModels.connections
            .filter((connection) => connection.credentialId)
            .map((connection) => ({
              connectionId: connection.id,
              name: connection.name,
              origin: new URL(connection.baseUrl).origin,
            })),
        ),
      ),
      keychain: Effect.fn("AccountSources.keychain")((source) =>
        Effect.tryPromise({
          try: async () => {
            const { AsyncEntry } = requireKeyring(
              "@napi-rs/keyring",
            ) as typeof import("@napi-rs/keyring");
            const value = await new AsyncEntry(source.service, source.account).getPassword();
            if (value == null) throw unavailable("Keychain item not found.");
            return Redacted.make(value);
          },
          catch: () => unavailable("Keychain item not found or unavailable."),
        }),
      ),
      customModel: Effect.fn("AccountSources.customModel")(function* (connectionId) {
        const connection = (yield* current).customModels.connections.find(
          (entry) => entry.id === connectionId,
        );
        if (!connection) return yield* unavailable("Custom models connection not found.");
        const resolved = yield* resolveCustomModelKey(connection, secrets);
        if (!resolved.apiKey) return yield* unavailable("Custom models key is unavailable.");
        return resolved.apiKey;
      }),
      onePassword: Effect.fn("AccountSources.onePassword")((hidden) =>
        Effect.tryPromise({
          try: async () => {
            const input = Redacted.value(hidden);
            const sdk = await import("@1password/sdk");
            const client = await sdk.createClient({
              auth:
                input.mode === "service-account"
                  ? input.token
                  : new sdk.DesktopAuth(input.accountName),
              integrationName: "Scient Accounts",
              integrationVersion: "1.0.0",
            });
            const label =
              input.mode === "desktop"
                ? input.accountName
                : (await client.vaults.list()).map((vault) => vault.title).join(", ") ||
                  "1Password";
            return {
              label,
              resolve: Effect.fn("AccountSources.onePassword.resolve")((reference: string) =>
                Effect.tryPromise({
                  try: async () => Redacted.make(await client.secrets.resolve(reference)),
                  catch: () => unavailable("1Password secret could not be resolved."),
                }),
              ),
            };
          },
          catch: () =>
            unavailable("1Password could not connect. Check the connection in 1Password."),
        }),
      ),
      candidates: Effect.fn("AccountSources.candidates")(function* (query) {
        if (platform === "linux") return { listed: false, candidates: [] };
        const output = yield* Effect.tryPromise({
          try: () =>
            new Promise<string>((resolve, reject) =>
              NodeChildProcess.execFile(
                platform === "macos" ? "/usr/bin/security" : "cmdkey",
                platform === "macos" ? ["dump-keychain"] : ["/list"],
                { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
                (error, stdout) => (error ? reject(error) : resolve(stdout)),
              ),
            ),
          catch: () => unavailable("Keychain item names could not be listed."),
        });
        return {
          listed: true,
          candidates: selectKeychainCandidates(
            platform === "macos" ? parseMacKeychain(output) : parseWindowsKeychain(output),
            query,
          ),
        };
      }),
    });
  }),
);
