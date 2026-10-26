// @effect-diagnostics nodeBuiltinImport:off -- Native keyring and metadata-only OS commands are lazy adapters.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import {
  AccountsError,
  BUILT_IN_BROWSER_PROFILES,
  type BrowserProfileId,
  type AccountCustomModelKey,
  type AccountDetails,
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
export const onePasswordWriteFailure = (cause: unknown) =>
  new AccountsError({
    reason:
      cause instanceof Error && /permission|forbidden|not authorized/i.test(cause.message)
        ? "denied"
        : "unavailable",
    message: "1Password copy could not be written.",
  });
const unavailable = (message: string) => new AccountsError({ reason: "unavailable", message });
export interface OnePasswordClient {
  readonly resolve: (reference: string) => Effect.Effect<Redacted.Redacted<string>, AccountsError>;
  readonly label: string;
  readonly vaults?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly readOnly: boolean;
  }>;
  readonly createLogin?: (input: {
    readonly vaultId: string;
    readonly copyId: string;
    readonly title: string;
    readonly details: AccountDetails;
    readonly field: string;
    readonly value: Redacted.Redacted<string>;
  }) => Effect.Effect<Extract<AccountValueSource, { type: "1password" }>, AccountsError>;
  readonly write?: (
    reference: string,
    value: Redacted.Redacted<string>,
  ) => Effect.Effect<void, AccountsError>;
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
    readonly writeKeychain: (
      source: Extract<AccountValueSource, { type: "keychain" }>,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, AccountsError>;
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
      writeKeychain: Effect.fn("AccountSources.writeKeychain")((source, value) =>
        Effect.tryPromise({
          try: async () => {
            const { AsyncEntry } = requireKeyring(
              "@napi-rs/keyring",
            ) as typeof import("@napi-rs/keyring");
            await new AsyncEntry(source.service, source.account).setPassword(Redacted.value(value));
          },
          catch: () => unavailable("System keychain copy could not be written."),
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
            const vaults = (await client.vaults.list()).map((vault) => ({
              id: vault.id,
              name: vault.title,
              readOnly: false,
            }));
            const label =
              input.mode === "desktop"
                ? input.accountName
                : vaults.map((vault) => vault.name).join(", ") || "1Password";
            return {
              label,
              vaults,
              createLogin: Effect.fn("AccountSources.onePassword.createLogin")(
                (input: Parameters<NonNullable<OnePasswordClient["createLogin"]>>[0]) =>
                  Effect.tryPromise({
                    try: async () => {
                      const tag = `scient:${input.copyId}`;
                      const previous = (await client.items.list(input.vaultId)).filter((item) =>
                        item.tags.includes(tag),
                      );
                      if (previous.length > 1) throw new Error("Copy identity is ambiguous");
                      if (previous[0]) {
                        const item = await client.items.get(input.vaultId, previous[0].id);
                        const field = item.fields.find((field) => field.id === input.field);
                        if (!field) throw new Error("Copy field is missing");
                        field.value = Redacted.value(input.value);
                        await client.items.put(item);
                        return {
                          type: "1password" as const,
                          reference: `op://${item.vaultId}/${item.id}/${input.field}`,
                        };
                      }
                      const item = await client.items.create({
                        tags: [tag],
                        vaultId: input.vaultId,
                        title: input.title,
                        category: sdk.ItemCategory.Login,
                        fields: [
                          ...((input.details.kind === "website" ||
                            input.details.kind === "library") &&
                          input.details.username !== undefined
                            ? [
                                {
                                  id: "username",
                                  title: "username",
                                  fieldType: sdk.ItemFieldType.Text,
                                  value: input.details.username,
                                },
                              ]
                            : []),
                          {
                            id: input.field,
                            title: input.field,
                            fieldType:
                              input.field === "totp"
                                ? sdk.ItemFieldType.Totp
                                : sdk.ItemFieldType.Concealed,
                            value: Redacted.value(input.value),
                          },
                        ],
                        websites:
                          "sites" in input.details
                            ? input.details.sites.map((site) => ({
                                url: site.startsWith("https://") ? site : `https://${site}`,
                                label: "",
                                autofillBehavior: site.startsWith("https://")
                                  ? sdk.AutofillBehavior.ExactDomain
                                  : sdk.AutofillBehavior.AnywhereOnWebsite,
                              }))
                            : [],
                      });
                      return {
                        type: "1password" as const,
                        reference: `op://${item.vaultId}/${item.id}/${input.field}`,
                      };
                    },
                    catch: onePasswordWriteFailure,
                  }),
              ),
              write: Effect.fn("AccountSources.onePassword.write")((reference, value) =>
                Effect.tryPromise({
                  try: async () => {
                    const parts = reference.slice(5).split("/");
                    if (parts.length < 3 || reference.includes("?"))
                      throw new Error("Unsupported field reference");
                    const vaultMatches = vaults.filter(
                      (vault) => vault.id === parts[0] || vault.name === parts[0],
                    );
                    if (vaultMatches.length !== 1) throw new Error("Vault not found");
                    const vaultId = vaultMatches[0]!.id;
                    const items = await client.items.list(vaultId);
                    const matches = items.filter(
                      (item) => item.id === parts[1] || item.title === parts[1],
                    );
                    if (matches.length !== 1) throw new Error("Item not found");
                    const item = await client.items.get(vaultId, matches[0]!.id);
                    const section =
                      parts.length === 4
                        ? item.sections.find(
                            (section) => section.id === parts[2] || section.title === parts[2],
                          )
                        : undefined;
                    const fields = item.fields.filter(
                      (field) =>
                        (field.id === parts.at(-1) || field.title === parts.at(-1)) &&
                        (parts.length !== 4 ||
                          (section !== undefined && field.sectionId === section.id)),
                    );
                    if (fields.length !== 1) throw new Error("Field not found");
                    fields[0]!.value = Redacted.value(value);
                    await client.items.put(item);
                  },
                  catch: onePasswordWriteFailure,
                }),
              ),
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
