import { AuthSettingsWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../../auth/http.ts";
import { AccountsService } from "./AccountsService.ts";

/**
 * Round 6f: what only the desktop's main process asks its own backend, with its own session. A
 * browser's saved passwords go straight into this backend's Accounts, never through a page; and
 * an operation's desktop part asks, as it writes, whether the operation still stands.
 */
export const scientAccountsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "scientAccounts",
  (handlers) => {
    // Asked per request: a server without Accounts refuses.
    const accounts = Effect.serviceOption(AccountsService);
    return Effect.succeed(
      handlers
        .handle("desktopPasswords", ({ endpoint, payload }) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(endpoint.name);
            yield* requireEnvironmentScope(AuthSettingsWriteScope);
            const service = yield* accounts;
            if (Option.isNone(service)) return { refused: "Accounts isn't open on this computer." };
            return yield* service.value.importPasswords(payload).pipe(
              Effect.map((result) => ({ result })),
              Effect.catch((error) => Effect.succeed({ refused: error.message })),
            );
          }),
        )
        .handle("desktopWriteCheck", ({ endpoint, payload }) =>
          Effect.gen(function* () {
            yield* annotateEnvironmentRequest(endpoint.name);
            yield* requireEnvironmentScope(AuthSettingsWriteScope);
            const service = yield* accounts;
            // No Accounts, no grant: the write is refused.
            if (Option.isNone(service)) return { ok: false, message: "Accounts isn't open." };
            return yield* service.value
              .desktopWriteCheck(payload)
              .pipe(Effect.catch((error) => Effect.succeed({ ok: false, message: error.message })));
          }),
        ),
    );
  },
);
