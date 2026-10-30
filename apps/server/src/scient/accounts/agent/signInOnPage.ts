import type { AccountSummary, PreviewAutomationStatus, PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AccountsError } from "@t3tools/contracts";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { authorizationDecision } from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { signIn } from "../signIn/engine.ts";
import { matchesAccountOrigin } from "../signIn/origin.ts";
import { withAccountUse } from "./accountUse.ts";

const isAccountsError = Schema.is(AccountsError);

const savedSignIn = (account: AccountSummary, url: string) =>
  (account.details.kind === "website" || account.details.kind === "library") &&
  account.secrets.password !== undefined &&
  matchesAccountOrigin(url, account.details.sites);

/** A rejected password stays rejected, and retrying can lock the account, until the user changes it. */
const rejected = (account: AccountSummary) =>
  account.lastSignInOutcome === "password-rejected" ||
  account.lastSignInOutcome === "code-rejected";

/**
 * Signs in on a login page with the saved sign-in for this page or the page the agent asked for,
 * so an agent never chains list, find and sign-in. Only Allowed accounts: an Ask account waits for
 * the agent to ask, by calling the sign-in tool. Undefined when there is nothing to say.
 */
export const signInOnPage = Effect.fn("AccountsAgent.signInOnPage")(function* (
  scope: AccountSessionScope,
  input: { readonly requestedUrl: string; readonly pageUrl: string; readonly tabId: PreviewTabId },
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope);
  if (!session.agentAccess) return undefined;
  const saved = [
    ...session.accounts.filter((account) => savedSignIn(account, input.pageUrl)),
    ...session.accounts.filter((account) => savedSignIn(account, input.requestedUrl)),
  ];
  const allowed = saved.find(
    (account) => authorizationDecision(true, account.controls, scope).decision === "allowed",
  );
  if (!allowed) {
    const ask = saved.find(
      (account) => authorizationDecision(true, account.controls, scope).decision === "ask",
    );
    return ask
      ? {
          note: `This page needs a sign-in. Call scient_account_sign_in with ${ask.accountId} (${ask.name}) to ask the user.`,
        }
      : undefined;
  }
  if (rejected(allowed))
    return {
      note: `This page needs a sign-in, and the site rejected ${allowed.name}'s saved sign-in last time. Ask the user to update it in Settings → Accounts & secrets.`,
    };
  const result = yield* withAccountUse(
    scope,
    { type: "account", accountId: allowed.accountId },
    "sign-in",
    Effect.gen(function* () {
      const values = yield* accounts.resolveSecrets(allowed.accountId, ["password", "totp"]);
      return yield* signIn(scope, allowed, values, input.tabId);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          outcome: "failed" as const,
          message: isAccountsError(error)
            ? error.message
            : "The browser sign-in could not be completed.",
        }),
      ),
    ),
    (done) => done.outcome === "signed-in",
    (done) => done.outcome,
  );
  if (result.outcome !== "signed-in" || !("tabId" in result))
    return {
      note: `This page needs a sign-in. ${result.message ?? "Signing in with the saved account did not finish."}`,
    };
  const tabId = result.tabId;
  const broker = yield* PreviewAutomationBroker;
  const invocation = yield* AgentInvocationContext;
  const invoke = <A>(operation: Parameters<typeof broker.invoke>[0]["operation"], data: unknown) =>
    broker.invoke<A>({ scope: invocation, operation, input: data, tabId, updateCurrentTab: false });
  // A sign-in often ends on the site's home page, not on what the agent asked for.
  const current = yield* invoke<PreviewAutomationStatus>("status", {});
  const opened =
    current.url === input.requestedUrl
      ? current
      : yield* invoke<PreviewAutomationStatus>("navigate", { url: input.requestedUrl }).pipe(
          Effect.orElseSucceed(() => current),
        );
  return { status: opened, note: `Signed in with ${allowed.name}.` };
});
