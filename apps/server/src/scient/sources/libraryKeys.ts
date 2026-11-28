import type { AccountSummary, LibraryKeyUse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSettingsService } from "../../serverSettings.ts";

/** Who is asking: the person's own Library, or an agent, which follows the Accounts switches. */
export type LibraryKeyCaller = "person" | "agent";

/**
 * The key a Library lookup sends: the choice in Library settings. A removed choice leaves it
 * without one until the person chooses again, so the Library never switches by itself. Without a
 * choice, today's pick among keys this caller may use; the person's first pick is kept.
 */
export const libraryKey = Effect.fn("LibraryKeys.resolve")(function* (input: {
  readonly use: LibraryKeyUse;
  readonly caller: LibraryKeyCaller;
  /** Keys that fit this lookup: kind, site and a token. */
  readonly candidates: ReadonlyArray<AccountSummary>;
  /** Today's selector over the keys it may pick from. */
  readonly pick: (keys: ReadonlyArray<AccountSummary>) => AccountSummary | undefined;
  readonly agentMayUse: (account: AccountSummary) => boolean;
}) {
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const choiceNow = Effect.gen(function* () {
    if (Option.isNone(settings)) return undefined;
    const current = yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    return current?.scientSources.keys[input.use];
  });
  const mayUse = (account: AccountSummary) =>
    input.caller === "person" ? account.controls.access !== "off" : input.agentMayUse(account);
  const choice = yield* choiceNow;
  if (choice !== undefined) {
    const chosen = input.candidates.find((account) => account.accountId === choice);
    return chosen && (input.caller === "person" || input.agentMayUse(chosen)) ? chosen : undefined;
  }
  const picked = input.pick(input.candidates.filter(mayUse));
  // Kept only if nothing was chosen meanwhile, checked inside the settings write.
  const keep = Option.isSome(settings) ? settings.value.updateSettingsIf : undefined;
  if (picked && input.caller === "person" && keep)
    yield* keep((current) => current.scientSources.keys[input.use] === undefined, {
      scientSources: { keys: { [input.use]: picked.accountId } },
    }).pipe(Effect.ignore);
  return picked;
});
