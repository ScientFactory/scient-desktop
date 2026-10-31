import type { AccountSummary, PreviewAutomationStatus, PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { authorizationDecision } from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { matchesAccountOrigin } from "../signIn/origin.ts";
import { guardedSignIn } from "./guardedSignIn.ts";

const savedSignIn = (account: AccountSummary, url: string) =>
  (account.details.kind === "website" || account.details.kind === "library") &&
  account.secrets.password !== undefined &&
  matchesAccountOrigin(url, account.details.sites);

const profileOf = ({ details }: AccountSummary) =>
  details.kind === "website" || details.kind === "library" ? details.profileId : undefined;

/** The accounts of this tab's profile, else those of no profile; never another profile's. */
const inProfile = (accounts: ReadonlyArray<AccountSummary>, profileId: string | undefined) => {
  const own = accounts.filter((account) => profileOf(account) === profileId);
  return own.length > 0 ? own : accounts.filter((account) => profileOf(account) === undefined);
};

/**
 * Signs in on a login page with the saved sign-in for this page or the page the agent asked for,
 * so an agent never chains list, find and sign-in. Only Allowed accounts: an Ask account waits for
 * the agent to ask, by calling the sign-in tool. Undefined when there is nothing to say.
 */
export const signInOnPage = Effect.fn("AccountsAgent.signInOnPage")(function* (
  scope: AccountSessionScope,
  input: {
    readonly requestedUrl: string;
    readonly pageUrl: string;
    readonly tabId: PreviewTabId;
    readonly profileId: string | undefined;
  },
) {
  const accounts = yield* AccountsService;
  const session = yield* accounts.forSession(scope);
  if (!session.agentAccess) return undefined;
  const decided = (url: string, decision: "allowed" | "ask") =>
    inProfile(
      session.accounts.filter((account) => savedSignIn(account, url)),
      input.profileId,
    ).filter(
      (account) => authorizationDecision(true, account.controls, scope).decision === decision,
    );
  const onPage = decided(input.pageUrl, "allowed");
  const allowedHere = onPage.length > 0 ? onPage : decided(input.requestedUrl, "allowed");
  if (allowedHere.length > 1)
    return {
      note: `This page needs a sign-in and several saved accounts fit. Call scient_account_sign_in with the one to use: ${allowedHere
        .map((account) => `${account.accountId} (${account.name})`)
        .join(", ")}.`,
    };
  const allowed = allowedHere[0];
  if (!allowed) {
    const ask = [...decided(input.pageUrl, "ask"), ...decided(input.requestedUrl, "ask")][0];
    return ask
      ? {
          note: `This page needs a sign-in. Call scient_account_sign_in with ${ask.accountId} (${ask.name}) to ask the user.`,
        }
      : undefined;
  }
  const result = yield* guardedSignIn(scope, allowed, {
    tabId: input.tabId,
    automatic: true,
    engine: { stopAtCode: true },
  });
  if (result.outcome !== "signed-in" || !("tabId" in result))
    return {
      note: `This page needs a sign-in. ${result.message ?? "Signing in with the saved account did not finish."}${
        result.outcome === "needs-user"
          ? ` Call scient_account_sign_in with ${allowed.accountId} on this tab, which asks the user privately.`
          : ""
      }`,
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
