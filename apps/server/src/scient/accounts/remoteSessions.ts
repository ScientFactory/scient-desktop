import { AccountsError, type AccountsQualifyCase } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { ServerConfig } from "../../config.ts";
import { ServerBrowser } from "../../preview/ServerBrowser.ts";
import { qualifyProfileCookies } from "./qualifyProfileCookies.ts";

const unavailable = (message: string) => new AccountsError({ reason: "unavailable", message });

/** Sign-ins another computer copies into this server's browser, one receiver per server. */
export class RemoteSessions extends Context.Service<
  RemoteSessions,
  {
    /** Dev servers only: item 3's cases on this computer's browser, in throwaway profiles. */
    readonly qualify: () => Effect.Effect<ReadonlyArray<AccountsQualifyCase>, AccountsError>;
  }
>()("t3/scient/accounts/remoteSessions") {}

export const makeRemoteSessions = Effect.gen(function* () {
  const browser = yield* ServerBrowser;
  const config = yield* ServerConfig;
  const profileCookies = browser.profileCookies;
  const qualifiable =
    config.devUrl !== undefined || process.env.SCIENT_QUALIFY_SESSION_COPY === "1";

  const qualify = Effect.fn("RemoteSessions.qualify")(function* () {
    if (!qualifiable || !profileCookies)
      return yield* unavailable("The check runs only on a development server.");
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    return yield* Effect.promise(() =>
      qualifyProfileCookies({
        open: (profileId) =>
          run(
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const jar = yield* profileCookies(profileId).pipe(Scope.provide(scope));
              return { jar, release: () => run(Scope.close(scope, Exit.void)) };
            }),
          ),
        clear: (profileId) => run(browser.clearProfile(profileId)),
      }),
    );
  });

  return RemoteSessions.of({ qualify });
});
