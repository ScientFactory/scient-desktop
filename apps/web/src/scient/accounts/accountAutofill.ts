import {
  ThreadId,
  type AccountSummary,
  type DesktopLoginForm,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { accountsState } from "./accountsState";
import { automaticSignIn, matchingAccounts } from "./accountsView";

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
 * never fills incognito. Agent access doesn't apply: the user's sign-ins are theirs; the server
 * keeps a filled page from agents that may not use that account.
 */
export function watchAccountAutofill(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const bridge = window.desktopBridge?.accounts;
  if (!bridge?.originBoundFill || !bridge.onLoginFormDetected) return () => undefined;
  const attempted = new Set<string>();
  const accounts = async (): Promise<ReadonlyArray<AccountSummary>> => {
    const current = registry.get(accountsState.snapshot({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(current)) return current.value.accounts;
    const read = await accountsState.readSnapshot.run(registry, { environmentId, input: {} });
    return read._tag === "Success" ? read.value.accounts : [];
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
    const account = matchingAccounts(await accounts(), form.url, form.profileId)[0];
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
