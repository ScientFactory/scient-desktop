import {
  DEFAULT_BROWSER_PROFILE_ID,
  type PreviewAutomationStatus,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { signInsForPage } from "@t3tools/shared/scientAccountSignIn";
import { PreviewAutomationBroker } from "../../../mcp/PreviewAutomationBroker.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { authorizationDecision } from "../AccountDecisions.ts";
import { AccountsService, type AccountSessionScope } from "../AccountsService.ts";
import { previewInvoker } from "./broker.ts";
import { guardedSignIn } from "./guardedSignIn.ts";

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
    signInsForPage(session.accounts, url, input.profileId ?? DEFAULT_BROWSER_PROFILE_ID).filter(
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
  const result = yield* guardedSignIn({
    page: { tabId: input.tabId },
    signIn: allowed,
    caller: { kind: "page", scope },
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
  const invoke = previewInvoker(broker, invocation, { updateCurrentTab: false });
  // A sign-in often ends on the site's home page, not on what the agent asked for.
  const current = yield* invoke<PreviewAutomationStatus>("status", {}, tabId);
  const opened =
    current.url === input.requestedUrl
      ? current
      : yield* invoke<PreviewAutomationStatus>("navigate", { url: input.requestedUrl }, tabId).pipe(
          Effect.orElseSucceed(() => current),
        );
  return { status: opened, note: `Signed in with ${allowed.name}.` };
});
