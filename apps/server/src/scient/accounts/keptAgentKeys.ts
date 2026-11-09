import {
  AccountsError,
  PROVIDER_DISPLAY_NAMES,
  keptAgentOf,
  type AccountId,
  type AccountRestoreKeptKeysInput,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SECRET_REDACTED, providerSettingsSecretFields } from "../../settingsSecrets.ts";
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";

const FIELD = "config.";

interface TypedKeys {
  readonly agent: string;
  readonly label: string;
  /** Setting (`AccountKeptFrom.setting`) to the value the user typed. */
  readonly keys: ReadonlyMap<string, string>;
}

/**
 * Keys the user typed into an instance. Read settings carry a stored variable's value with its
 * redacted mark; a value Scient couldn't read keeps the one read before, so it is never lost.
 */
function typedKeys(instance: ProviderInstanceConfig, before: TypedKeys | undefined): TypedKeys {
  const config = (instance.config ?? {}) as Readonly<Record<string, unknown>>;
  const read = [
    ...(instance.environment ?? []).flatMap((variable) =>
      variable.sensitive && typeof variable.value === "string"
        ? [
            [
              variable.name,
              variable.value,
              variable.valueRedacted === true && !variable.value,
            ] as const,
          ]
        : [],
    ),
    ...providerSettingsSecretFields(instance.driver).flatMap((field) => {
      const value = config[field];
      return typeof value === "string"
        ? [[FIELD + field, value, value === SECRET_REDACTED] as const]
        : [];
    }),
  ];
  return {
    agent: keptAgentOf(instance),
    label:
      instance.displayName ??
      PROVIDER_DISPLAY_NAMES[instance.driver as ProviderDriverKind] ??
      instance.driver,
    keys: new Map(
      read.flatMap(([setting, value, redacted]) => {
        const kept = redacted ? before?.keys.get(setting) : value;
        return kept ? [[setting, kept] as const] : [];
      }),
    ),
  };
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
 * deletes. Scient keeps each one as an API-key account first (`keptFrom`), and adding an agent of
 * the same kind can put them back (`restore`).
 */
export const makeKeptAgentKeys = Effect.fn("KeptAgentKeys.make")(function* (
  accounts: AccountsServiceShape,
) {
  const settings = yield* ServerSettingsService;
  let known = new Map<string, TypedKeys>();

  const read = (next: ServerSettings) =>
    new Map(
      Object.entries(next.providerInstances).map(([instanceId, instance]) => [
        instanceId,
        typedKeys(instance, known.get(instanceId)),
      ]),
    );

  const keep = Effect.fn("KeptAgentKeys.keep")(function* (instanceId: string, typed: TypedKeys) {
    const snapshot = yield* accounts.snapshot;
    for (const [setting, value] of typed.keys) {
      const linked = snapshot.keyLinks?.some(
        (link) =>
          link.instanceId === instanceId &&
          link.variable === setting &&
          snapshot.accounts.some((account) => account.accountId === link.accountId),
      );
      if (linked) continue;
      let kept = false;
      for (const account of snapshot.accounts) {
        const from = account.details.kind === "api-key" ? account.details.keptFrom : undefined;
        if (kept || from?.agent !== typed.agent || from.setting !== setting) continue;
        const { token } = yield* accounts
          .resolveSecrets(account.accountId, ["token"])
          .pipe(Effect.orElseSucceed(() => ({}) as { token?: Redacted.Redacted<string> }));
        kept = token !== undefined && Redacted.value(token) === value;
      }
      if (kept) continue;
      yield* accounts.save({
        name: `${typed.label} · ${settingLabel(setting)}`,
        details: {
          kind: "api-key",
          sites: [],
          auth: { type: "bearer" },
          ...(setting.startsWith(FIELD) ? {} : { envName: setting }),
          keptFrom: { agent: typed.agent, setting },
        },
        secrets: { token: { type: "scient", value } },
      });
    }
  });

  const observe = (next: ServerSettings) =>
    Effect.suspend(() => {
      const gone = [...known].filter(([instanceId]) => !(instanceId in next.providerInstances));
      known = read(next);
      return Effect.forEach(
        gone,
        ([instanceId, typed]) =>
          keep(instanceId, typed).pipe(
            Effect.catch((error) =>
              Effect.logWarning("could not keep a removed agent's keys in Accounts", {
                instanceId,
                reason: error.reason,
              }),
            ),
          ),
        { discard: true },
      );
    });

  yield* Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      const current = yield* settings.getSettings.pipe(Effect.option);
      if (current._tag === "Some") known = read(current.value);
      yield* Stream.runForEach(changes, observe);
    }),
  ).pipe(Effect.forkScoped);

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

/** Server-lifetime: the keeper must see every settings change, whichever client made it. */
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
