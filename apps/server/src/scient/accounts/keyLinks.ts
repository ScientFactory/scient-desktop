import {
  AccountsError,
  type AccountKeyLink,
  type AccountsSnapshot,
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
  // with the same id starts clean and a removal that failed keeps its links.
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
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      const current = yield* settings.getSettings.pipe(Effect.option);
      if (current._tag === "Some") yield* dropRemoved(current.value);
      yield* Stream.runForEach(changes, dropRemoved);
    }),
  ).pipe(Effect.forkScoped);

  return Effect.fn("AccountKeyLinks.link")(function* (link: AccountKeyLink) {
    yield* apply(link);
    yield* accounts.setKeyLink(link, link.accountId);
  });
});

/** Server-lifetime, so a key changed in Accounts reaches its variables whenever it changes. */
export class AccountKeyLinks extends Context.Service<
  AccountKeyLinks,
  { readonly link: (link: AccountKeyLink) => Effect.Effect<void, AccountsError> }
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
