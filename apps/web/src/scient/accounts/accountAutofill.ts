import { ThreadId, type DesktopLoginForm, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { readThreadPreviewState } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadShells } from "~/state/threads";
import { accountsState } from "./accountsState";
import { agentMayUse, automaticSignIn, matchingAccounts } from "./accountsView";

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
 * Fills a saved sign-in into every login form the desktop reports for this environment's tabs,
 * shown or hidden, the user's or an agent's. It never submits, never replaces typed text, and
 * never fills incognito. In the user's tabs every saved sign-in fills, and the server keeps a
 * filled page from agents that may not use it; in an agent's tab, only sign-ins that agent may use.
 */
export function watchAccountAutofill(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bridge = window.desktopBridge?.accounts;
  if (!bridge?.originBoundFill || !bridge.onLoginFormDetected) return () => undefined;
  const attempted = new Set<string>();
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
    const account = matchingAccounts(accounts.accounts, form.url, form.profileId).find(
      (match) => !agentTab || agentMayUse(match.controls, accounts.agentAccess, projectId),
    );
    if (!account) return;
    const pageUrl = form.pageUrl ?? form.url;
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
        ...(values.value.username === undefined ? {} : { username: values.value.username }),
        ...(values.value.password === undefined ? {} : { password: values.value.password }),
        ...(values.value.otp === undefined ? {} : { otp: values.value.otp }),
      })
      .catch(() => false);
    if (!done) return;
    filled.set(form.tabId, { accountId: account.accountId, url: pageUrl });
    for (const listener of listeners) listener();
  };
  return bridge.onLoginFormDetected((form) => void fill(form));
}
