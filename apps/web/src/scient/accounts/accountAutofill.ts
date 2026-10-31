import { ThreadId, type DesktopLoginForm, type EnvironmentId } from "@t3tools/contracts";
import { isLoginPlace } from "@t3tools/shared/scientSignInPage";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { readThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import { accountsState } from "./accountsState";
import { agentMayUse, automaticSignIn, fillableAccounts } from "./accountsView";

/** Runtime tab ids are `[environmentId, threadId, serverEpoch, tabId]` (`previewRuntimeTabId`). */
function runtimeTab(id: string) {
  try {
    const [environmentId, threadId, , tabId] = JSON.parse(id) as unknown[];
    return typeof environmentId === "string" &&
      typeof threadId === "string" &&
      typeof tabId === "string"
      ? { environmentId, threadId, tabId }
      : null;
  } catch {
    return null;
  }
}

/** The server's record of a fill in a runtime tab, which keeps the page from agents that may not use it. */
export function filledTabRecord(runtimeTabId: string, url: string) {
  const tab = runtimeTab(runtimeTabId);
  return tab ? { threadId: ThreadId.make(tab.threadId), tabId: tab.tabId, url } : undefined;
}

/** Signing back in is tried once per site in this long: a wrong password must not repeat. */
const SIGN_BACK_IN_COOLDOWN_MS = 10 * 60 * 1000;
/** A submitted form has had time to reject the password by now. */
const SIGN_IN_SETTLE_MS = 6_000;

const filled = new Map<string, { readonly accountId: string; readonly url: string }>();
const listeners = new Set<() => void>();

/** The sign-in autofill put into each runtime tab, for the toolbar's chip. */
export const autofilledTabs = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (runtimeTabId: string) => filled.get(runtimeTabId),
};

/**
 * Fills saved sign-ins into every login form in this environment's tabs, but never over typed text
 * or in incognito. An agent's tab gets only what that agent may use; the server keeps the user's
 * filled pages from other agents. It submits only to sign the user back in: their own tab, the
 * site's one saved sign-in, known to work.
 */
export function watchAccountAutofill(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bridge = window.desktopBridge?.accounts;
  if (!bridge?.originBoundFill || !bridge.onLoginFormDetected) return () => undefined;
  const attempted = new Set<string>();
  const signedBackIn = new Map<string, number>();
  const snapshot = async () => {
    const current = registry.get(accountsState.snapshot({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(current)) return current.value;
    const read = await accountsState.readSnapshot.run(registry, { environmentId, input: {} });
    return read._tag === "Success" ? read.value : undefined;
  };
  const fill = async (form: DesktopLoginForm) => {
    const tab = runtimeTab(form.tabId);
    if (
      tab?.environmentId !== environmentId ||
      attempted.has(form.documentId) ||
      !automaticSignIn(form)
    )
      return;
    attempted.add(form.documentId);
    const accounts = await snapshot();
    if (!accounts) return;
    // A page an agent controls can read what is filled, so it gets only accounts that agent may use.
    const threadRef = { environmentId, threadId: ThreadId.make(tab.threadId) };
    const agentTab =
      readThreadPreviewState(threadRef).sessions[tab.tabId]?.automationOwner !== undefined;
    const projectId = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom(threadRef),
    )?.projectId;
    const matches = fillableAccounts(accounts.accounts, form.url, form.profileId);
    const account = matches.find(
      (match) =>
        !agentTab ||
        (agentMayUse(match.controls, accounts.agentAccess, projectId) &&
          match.lastSignInOutcome !== "password-rejected" &&
          match.lastCheck?.state !== "limited"),
    );
    if (!account) return;
    const lastSubmitted = signedBackIn.get(form.url) ?? 0;
    const pageUrl = form.pageUrl ?? form.url;
    // Only a sign-in page: a form asking for the password on "close account" looks just the same.
    const submit =
      !agentTab &&
      matches.length === 1 &&
      account.details.kind === "website" &&
      (account.details.profileId ?? form.profileId) === form.profileId &&
      account.lastSignInOutcome === "signed-in" &&
      account.lastCheck?.state !== "limited" &&
      account.secrets.password !== undefined &&
      isLoginPlace(new URL(pageUrl)) &&
      Date.now() - lastSubmitted > SIGN_BACK_IN_COOLDOWN_MS;
    if (submit) signedBackIn.set(form.url, Date.now());
    const values = await accountsState.fillValues.run(registry, {
      environmentId,
      input: {
        accountId: account.accountId,
        origin: form.url,
        tab: { threadId: ThreadId.make(tab.threadId), tabId: tab.tabId, url: pageUrl },
      },
    });
    if (values._tag !== "Success") return;
    const done = await bridge
      // oxlint-disable-next-line unicorn/no-array-fill-with-reference-type -- The desktop bridge's fill, not Array.fill.
      .fill({
        tabId: form.tabId,
        expectedOrigin: form.url,
        documentId: form.documentId,
        automatic: true,
        ...(submit ? { submit: true } : {}),
        ...(values.value.username === undefined ? {} : { username: values.value.username }),
        ...(values.value.password === undefined ? {} : { password: values.value.password }),
        ...(values.value.otp === undefined ? {} : { otp: values.value.otp }),
      })
      .catch(() => false);
    if (!done) return;
    filled.set(form.tabId, { accountId: account.accountId, url: pageUrl });
    for (const listener of listeners) listener();
    if (done !== "submitted") return;
    await new Promise((settled) => setTimeout(settled, SIGN_IN_SETTLE_MS));
    const still = await bridge.loginForm?.(form.tabId).catch(() => undefined);
    if (!still?.hasPassword || still.url !== form.url) return;
    // Retries could lock the account. Only a page that came back with the form again means the
    // password no longer works: the same page may still be waiting or asking for something else.
    if (still.documentId === form.documentId) signedBackIn.set(form.url, Number.POSITIVE_INFINITY);
    else
      await accountsState.signInSeen.run(registry, {
        environmentId,
        input: { accountId: account.accountId, outcome: "password-rejected" },
      });
  };
  return bridge.onLoginFormDetected((form) => void fill(form));
}
