import type { AccountId, AccountKeyCheck, AccountsError } from "@t3tools/contracts";
import { anySiteMatches } from "@t3tools/shared/scientSiteMatch";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { accountRequest } from "./agent/request.ts";
import { AccountsService, type AccountUseScope } from "./AccountsService.ts";

/**
 * A read-only request each known service answers only for a key it accepts. Any other service
 * has none Scient can trust, so its Check says only that the value reads.
 */
const KEY_CHECKS: ReadonlyArray<{
  readonly origin: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
}> = [
  { origin: "https://api.openai.com", path: "/v1/models" },
  {
    origin: "https://api.anthropic.com",
    path: "/v1/models",
    headers: { "anthropic-version": "2023-06-01" },
  },
  { origin: "https://openrouter.ai", path: "/api/v1/key" },
  { origin: "https://generativelanguage.googleapis.com", path: "/v1beta/models" },
  { origin: "https://api.mistral.ai", path: "/v1/models" },
  { origin: "https://api.groq.com", path: "/openai/v1/models" },
  { origin: "https://api.x.ai", path: "/v1/models" },
  { origin: "https://api.deepseek.com", path: "/models" },
  { origin: "https://api.together.xyz", path: "/v1/models" },
  { origin: "https://api.elevenlabs.io", path: "/v1/user" },
  { origin: "https://api.deepgram.com", path: "/v1/projects" },
  { origin: "https://api.zotero.org", path: "/keys/current" },
];

/**
 * A Check on a key: its saved value must read, then its service must accept it. Only a success
 * from the service is `works`; a 401 or 403 is `refused`; anything else is `readable`. An agent's
 * Check (`agent`) passes the use-time gate as an agent's request does, after the read and as it
 * leaves; the person's never does.
 */
export const checkKey = Effect.fn("Accounts.checkKey")(function* (
  accountId: AccountId,
  transport?: Parameters<typeof accountRequest>[6],
  agent?: AccountUseScope,
) {
  const accounts = yield* AccountsService;
  yield* accounts.test(accountId);
  const row = (yield* accounts.snapshot).accounts.find((item) => item.accountId === accountId);
  const details = row?.details;
  if (details?.kind !== "api-key") return "readable" satisfies AccountKeyCheck;
  const check = KEY_CHECKS.find(({ origin }) => anySiteMatches(details.sites, origin));
  if (!check) return "readable" satisfies AccountKeyCheck;
  const { token } = yield* accounts.resolveSecrets(accountId, ["token"]);
  if (!token) return "readable" satisfies AccountKeyCheck;
  const gate = (origin?: string) =>
    agent
      ? accounts.authorizeUse(agent, { type: "account", accountId }, { since: row, origin })
      : Effect.void;
  yield* gate();
  const services = yield* Effect.context<never>();
  // The request reports any failure as one refusal; the gate's own is kept apart from it.
  let refused: AccountsError | undefined;
  const answered = yield* Effect.tryPromise({
    try: () =>
      accountRequest(
        { method: "GET", url: `${check.origin}${check.path}`, headers: check.headers },
        [check.origin],
        true,
        details.auth,
        Redacted.value(token),
        AbortSignal.timeout(10_000),
        transport,
        (url) =>
          Effect.runPromiseWith(services)(
            gate(url.origin).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  refused = error;
                }),
              ),
            ),
          ),
      ),
    catch: () => undefined,
  }).pipe(Effect.result);
  // Refused by the gate, nothing went; unreachable, or an answer Scient can't read, says nothing.
  if (answered._tag === "Failure")
    return refused ? yield* refused : ("readable" satisfies AccountKeyCheck);
  const { status } = answered.success;
  return (
    status >= 200 && status < 300
      ? "works"
      : status === 401 || status === 403
        ? "refused"
        : "readable"
  ) satisfies AccountKeyCheck;
});
