import {
  ACCOUNTS_PROTOCOL,
  ThreadId,
  type DesktopCapturedSignIn,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { runtimeTab } from "./accountAutofill";
import { accountsState } from "./accountsState";

/**
 * What the user types in a tab where Scient runs their sign-in goes to that attempt, which keeps it
 * once the sign-in is proven. Window-wide: the tab's toolbar may be gone, and a university's tab
 * closes itself as the sign-in ends.
 */
export function watchSignInKeeps(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  const subscribe = window.desktopBridge?.accounts?.onSignInCaptured;
  if (!subscribe) return () => undefined;
  const atom = accountsState.snapshot({ environmentId, input: {} });
  return subscribe((capture: DesktopCapturedSignIn) => {
    const tab = runtimeTab(capture.tabId);
    const result = registry.get(atom);
    if (tab?.environmentId !== environmentId || !AsyncResult.isSuccess(result)) return;
    const snapshot = result.value;
    const attempt = snapshot.attempts?.find(
      (item) => item.threadId === tab.threadId && item.tabId === tab.tabId,
    );
    if ((snapshot.accountsProtocol ?? 0) < ACCOUNTS_PROTOCOL || !attempt) return;
    void accountsState.keepTyped
      .run(registry, {
        environmentId,
        input: {
          attemptId: attempt.attemptId,
          threadId: ThreadId.make(tab.threadId),
          tabId: tab.tabId,
          origin: capture.url,
          path: capture.path,
          step: capture.step,
          username: capture.username,
          password: capture.password,
        },
      })
      .catch(() => undefined);
  });
}
