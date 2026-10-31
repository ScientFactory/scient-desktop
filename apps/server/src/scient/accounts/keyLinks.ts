import {
  AccountsError,
  type AccountKeyLink,
  type AccountsSnapshot,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { AccountsServiceShape } from "./AccountsService.ts";

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

  return Effect.fn("AccountKeyLinks.link")(function* (link: AccountKeyLink) {
    yield* apply(link);
    yield* accounts.setKeyLink(link, link.accountId);
  });
});
