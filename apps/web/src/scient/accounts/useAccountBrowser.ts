import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  type EnvironmentId,
} from "@t3tools/contracts";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import { toastManager } from "~/components/ui/toast";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { accountsState } from "./accountsState";
import { profileAccounts } from "./accountsView";
import { useAccountCommand } from "./useAccounts";

const SIGN_IN_WINDOW_MS = 600_000;

/** Sites being signed in to from Add an account, until Done or expiry; the SSO offer stays quiet. */
const signingIn = new Map<string, number>();
const signingInKey = (environmentId: EnvironmentId, profileId: string, url: string) => {
  try {
    return `${environmentId}:${profileId}:${new URL(url).hostname}`;
  } catch {
    return null;
  }
};

export function isSigningIn(environmentId: EnvironmentId, profileId: string, url: string) {
  const key = signingInKey(environmentId, profileId, url);
  return key !== null && (signingIn.get(key) ?? 0) > Date.now();
}

/**
 * Opens a site in a Scient browser tab. With `signIn`, the user signs in there however the site
 * allows and presses Done; a typed password is still offered by the browser's save prompt, and
 * any other sign-in is kept as an account that uses this profile's session.
 */
export function useAccountBrowser(environmentId: EnvironmentId) {
  const newTabProfileId =
    useClientSettings((settings) => settings.browserDefaultProfileId) ?? DEFAULT_BROWSER_PROFILE_ID;
  const save = useAccountCommand(accountsState.save, environmentId);
  const readSnapshot = useAccountCommand(accountsState.readSnapshot, environmentId);
  const { openScratchProject } = useScratchProject();
  const openThread = useNewThreadHandler();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  const finishSignIn = (signIn: { name: string; site: string }, profileId: string) => {
    const site = /^https?:\/\//.test(signIn.site) ? signIn.site : `https://${signIn.site}`;
    const key = signingInKey(environmentId, profileId, site);
    if (key === null) return;
    signingIn.set(key, Date.now() + SIGN_IN_WINDOW_MS);
    const toast = toastManager.add({
      type: "info",
      title: `Sign in to ${signIn.name}, then press Done`,
      timeout: SIGN_IN_WINDOW_MS,
      actionProps: {
        children: "Done",
        onClick: async () => {
          signingIn.delete(key);
          toastManager.close(toast);
          // Read now: a password typed meanwhile was saved through the browser's own prompt.
          const current = await readSnapshot({});
          if (!current.ok) return;
          if (
            profileAccounts(current.value.accounts, site, profileId, newTabProfileId).length === 0
          ) {
            const result = await save({
              name: signIn.name,
              details: { kind: "website", sites: [new URL(site).origin], profileId },
              secrets: {},
            });
            if (!result.ok) return;
          }
          toastManager.add({ type: "success", title: `${signIn.name} saved to Accounts` });
        },
      },
    });
  };

  return async (url: string, profileId?: string, signIn?: { name: string; site: string }) => {
    const project = await openScratchProject(environmentId, "Could not open the site");
    if (!project) return false;
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id));
    if (!opened) return false;
    const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
    useRightPanelStore.getState().requestMaximize(threadRef);
    const profile = profileId ?? newTabProfileId;
    const result = await openUrlInPreview({
      threadRef,
      url: /^https?:\/\//.test(url) ? url : `https://${url}`,
      openPreview,
      profileId: BrowserProfileId.make(profile),
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not open the site" });
      return false;
    }
    if (signIn) finishSignIn(signIn, profile);
    return true;
  };
}
