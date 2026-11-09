import {
  AccountsError,
  PROVIDER_DISPLAY_NAMES,
  type AccountId,
  type AccountKeyLink,
  type AccountLinkKeyInput,
  type AccountsSnapshot,
  type ProviderDriverKind,
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
import { AccountsService, type AccountsServiceShape } from "./AccountsService.ts";

const failure = (message: string) => new AccountsError({ reason: "unavailable", message });

/**
 * Lets a provider variable use a key from Accounts. Providers read their variables at start, so the
 * value is copied into the variable and copied again whenever the account's key changes.
 */
export const makeAccountKeyLinks = Effect.fn("AccountKeyLinks.make")(function* (
  accounts: AccountsServiceShape,
) {
  const settings = yield* ServerSettingsService;
  const apply = Effect.fn("AccountKeyLinks.apply")(function* (link: AccountKeyLink) {
    const { token } = yield* accounts.resolveSecrets(link.accountId, ["token"]);
    if (!token) return yield* failure("This account has no key to use.");
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("Provider settings are unavailable.")),
    );
    const instanceId = link.instanceId as ProviderInstanceId;
    const instance = current.providerInstances[instanceId];
    const variable = instance?.environment?.find((item) => item.name === link.variable);
    if (!instance || !variable) return yield* failure("This variable no longer exists.");
    if (variable.value === Redacted.value(token)) return;
    yield* settings
      .updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: {
          ...instance,
          environment: (instance.environment ?? []).map((item) =>
            item.name === link.variable
              ? { name: item.name, value: Redacted.value(token), sensitive: true }
              : item,
          ),
        },
      })
      .pipe(Effect.mapError(() => failure("The provider variable could not be updated.")));
  });

  const seen = new Map<string, string>();
  const follow = (snapshot: AccountsSnapshot) =>
    Effect.forEach(
      snapshot.keyLinks ?? [],
      (link) => {
        const account = snapshot.accounts.find((item) => item.accountId === link.accountId);
        const key = `${link.instanceId}\u0000${link.variable}`;
        if (!account || seen.get(key) === account.updatedAt) return Effect.void;
        return apply(link).pipe(
          Effect.tap(() => Effect.sync(() => seen.set(key, account.updatedAt))),
          Effect.ignore,
        );
      },
      { discard: true },
    );
  yield* Stream.runForEach(accounts.changes, follow).pipe(Effect.forkScoped);

  // After a settings change commits, links of agents that no longer exist go, so a later agent
  // with the same id starts clean and a removal that failed keeps its links. Only on a change, so
  // startup never opens Accounts.
  const dropRemoved = (current: ServerSettings) =>
    accounts.snapshot.pipe(
      Effect.flatMap((snapshot) =>
        Effect.forEach(
          (snapshot.keyLinks ?? []).filter(
            (link) => !(link.instanceId in current.providerInstances),
          ),
          (link) => accounts.setKeyLink(link),
          { discard: true },
        ),
      ),
      Effect.ignore,
    );
  yield* Effect.scoped(
    settings.subscribeChanges.pipe(
      Effect.flatMap((changes) => Stream.runForEach(changes, dropRemoved)),
    ),
  ).pipe(Effect.forkScoped);

  // The variable's key as an API key: an account already holding the same key, else a new one.
  const keep = Effect.fn("AccountKeyLinks.keep")(function* (
    target: Omit<AccountKeyLink, "accountId">,
  ) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("Provider settings are unavailable.")),
    );
    const instance = current.providerInstances[target.instanceId as ProviderInstanceId];
    const value = instance?.environment?.find(
      (item) => item.name === target.variable && item.sensitive,
    )?.value;
    // A reference to another secret store has no value here to keep.
    if (!instance || typeof value !== "string" || !value)
      return yield* failure("This variable has no key Scient can keep.");
    const snapshot = yield* accounts.snapshot;
    for (const account of snapshot.accounts) {
      if (account.details.kind !== "api-key" || account.details.envName !== target.variable)
        continue;
      const { token } = yield* accounts.resolveSecrets(account.accountId, ["token"]);
      if (token !== undefined && Redacted.value(token) === value) return account.accountId;
    }
    const label =
      instance.displayName ??
      PROVIDER_DISPLAY_NAMES[instance.driver as ProviderDriverKind] ??
      instance.driver;
    const saved = yield* accounts.save({
      name: `${label} · ${target.variable}`.slice(0, 80),
      details: { kind: "api-key", sites: [], auth: { type: "bearer" }, envName: target.variable },
      secrets: { token: { type: "scient", value } },
    });
    return saved.accountId;
  });

  return Effect.fn("AccountKeyLinks.link")(function* (input: AccountLinkKeyInput) {
    const accountId: AccountId = input.accountId ?? (yield* keep(input));
    const link = { ...input, accountId };
    yield* apply(link);
    yield* accounts.setKeyLink(link, accountId);
  });
});

/** Server-lifetime, so a key changed in Accounts reaches its variables whenever it changes. */
export class AccountKeyLinks extends Context.Service<
  AccountKeyLinks,
  { readonly link: (input: AccountLinkKeyInput) => Effect.Effect<void, AccountsError> }
>()("t3/scient/accounts/keyLinks/AccountKeyLinks") {}

export const layer = Layer.effect(
  AccountKeyLinks,
  Effect.gen(function* () {
    return { link: yield* makeAccountKeyLinks(yield* AccountsService) };
  }),
);

/** The RPC side; a server without Accounts answers that it is unavailable. */
export const linkKeyForRpc = Effect.serviceOption(AccountKeyLinks).pipe(
  Effect.map(
    Option.match({
      onNone: () => () => Effect.fail(failure("Accounts is unavailable.")),
      onSome: (service) => service.link,
    }),
  ),
);
