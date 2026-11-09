import {
  AccountsError,
  PROVIDER_DISPLAY_NAMES,
  keptAgentOf,
  type AccountId,
  type AccountRestoreKeptKeysInput,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SECRET_REDACTED, providerSettingsSecretFields } from "../../settingsSecrets.ts";
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";
import type { RemovedAgent } from "./removedAgentKeys.ts";

const FIELD = "config.";

/** Keys the user typed into an instance, read from the secret store: setting to value. */
function typedKeys(instance: ProviderInstanceConfig) {
  const config = (instance.config ?? {}) as Readonly<Record<string, unknown>>;
  return [
    ...(instance.environment ?? []).flatMap((variable) =>
      variable.sensitive && typeof variable.value === "string" && variable.value
        ? [[variable.name, variable.value] as const]
        : [],
    ),
    ...providerSettingsSecretFields(instance.driver).flatMap((field) => {
      const value = config[field];
      return typeof value === "string" && value && value !== SECRET_REDACTED
        ? [[FIELD + field, value] as const]
        : [];
    }),
  ];
}

const settingLabel = (setting: string) =>
  setting.startsWith(FIELD)
    ? setting
        .slice(FIELD.length)
        .replace(/([a-z])([A-Z])/gu, "$1 $2")
        .toLowerCase()
        .replace(/^api\b/u, "API")
        .replace(/^\w/u, (letter) => letter.toUpperCase())
    : setting;

const failure = (reason: "not-found" | "invalid-input" | "unavailable", message: string) =>
  new AccountsError({ reason, message });

/**
 * Keys typed into an agent's settings live in that agent's settings, which removing the agent
 * deletes. Inside that settings write, before the deletion, Scient keeps each one as an API-key
 * account (`keptFrom`); adding an agent of the same kind can put them back (`restore`).
 */
export const makeKeptAgentKeys = Effect.fn("KeptAgentKeys.make")(function* (
  accounts: AccountsServiceShape,
) {
  const settings = yield* ServerSettingsService;

  const keep = Effect.fn("KeptAgentKeys.keep")(function* (removed: ReadonlyArray<RemovedAgent>) {
    const snapshot = yield* accounts.snapshot;
    for (const { instanceId, instance } of removed) {
      const agent = keptAgentOf(instance);
      const label =
        instance.displayName ??
        PROVIDER_DISPLAY_NAMES[instance.driver as ProviderDriverKind] ??
        instance.driver;
      const links = (snapshot.keyLinks ?? []).filter((link) => link.instanceId === instanceId);
      for (const [setting, value] of typedKeys(instance)) {
        // Already in Accounts, or its account was deleted on purpose: either way, not kept again.
        if (links.some((link) => link.variable === setting)) continue;
        let kept = false;
        for (const account of snapshot.accounts) {
          const from = account.details.kind === "api-key" ? account.details.keptFrom : undefined;
          if (kept || from?.agent !== agent || from.setting !== setting) continue;
          const { token } = yield* accounts.resolveSecrets(account.accountId, ["token"]);
          kept = token !== undefined && Redacted.value(token) === value;
        }
        if (kept) continue;
        yield* accounts.save({
          name: `${label} · ${settingLabel(setting)}`,
          details: {
            kind: "api-key",
            sites: [],
            auth: { type: "bearer" },
            ...(setting.startsWith(FIELD) ? {} : { envName: setting }),
            keptFrom: { agent, setting },
          },
          secrets: { token: { type: "scient", value } },
        });
      }
      // The agent is gone; a later one with the same id starts with no links.
      for (const link of links) yield* accounts.setKeyLink(link);
    }
  });
  if (settings.setRemovedAgentKeeper) yield* settings.setRemovedAgentKeeper(keep);

  return Effect.fn("KeptAgentKeys.restore")(function* (input: AccountRestoreKeptKeysInput) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("unavailable", "Provider settings are unavailable.")),
    );
    const instanceId = input.instanceId as ProviderInstanceId;
    const instance = current.providerInstances[instanceId];
    if (!instance) return yield* failure("not-found", "This agent no longer exists.");
    const agent = keptAgentOf(instance);
    const snapshot = yield* accounts.snapshot;
    let environment = instance.environment ?? [];
    const fields: Record<string, string> = {};
    const links: Array<{ readonly variable: string; readonly accountId: AccountId }> = [];
    for (const accountId of input.accountIds) {
      const account = snapshot.accounts.find((item) => item.accountId === accountId);
      const from = account?.details.kind === "api-key" ? account.details.keptFrom : undefined;
      if (from?.agent !== agent)
        return yield* failure("invalid-input", "This key wasn't kept from this kind of agent.");
      const { token } = yield* accounts.resolveSecrets(accountId, ["token"]);
      if (!token) return yield* failure("not-found", "This account has no key to use.");
      if (from.setting.startsWith(FIELD)) {
        fields[from.setting.slice(FIELD.length)] = Redacted.value(token);
        continue;
      }
      environment = [
        ...environment.filter((variable) => variable.name !== from.setting),
        { name: from.setting, value: Redacted.value(token), sensitive: true },
      ];
      links.push({ variable: from.setting, accountId });
    }
    yield* settings
      .updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          ...instance,
          environment,
          ...(Object.keys(fields).length
            ? { config: { ...(instance.config as object | undefined), ...fields } }
            : {}),
        },
      })
      .pipe(
        Effect.mapError(() => failure("unavailable", "The agent's settings could not be updated.")),
      );
    // A variable then follows its account, so removing the agent again keeps nothing twice.
    for (const link of links)
      yield* accounts.setKeyLink({ instanceId, variable: link.variable }, link.accountId);
  });
});

/** Server-lifetime, so every removal is kept whichever client makes it. */
export class KeptAgentKeys extends Context.Service<
  KeptAgentKeys,
  {
    readonly restore: (input: AccountRestoreKeptKeysInput) => Effect.Effect<void, AccountsError>;
  }
>()("t3/scient/accounts/keptAgentKeys") {}

export const layer = Layer.effect(
  KeptAgentKeys,
  Effect.gen(function* () {
    return { restore: yield* makeKeptAgentKeys(yield* AccountsService) };
  }),
);

/** The RPC side; a server without Accounts answers that it is unavailable. */
export const restoreKeptKeysForRpc = Effect.serviceOption(KeptAgentKeys).pipe(
  Effect.map(
    Option.match({
      onNone: () => () => Effect.fail(failure("unavailable", "Accounts is unavailable.")),
      onSome: (service) => service.restore,
    }),
  ),
);
