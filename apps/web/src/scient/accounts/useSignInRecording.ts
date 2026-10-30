import { useEffect, useEffectEvent, useRef } from "react";
import type { AccountSummary, EnvironmentId } from "@t3tools/contracts";
import { useClientSettings } from "~/hooks/useSettings";
import { toastManager } from "~/components/ui/toast";
import { isIdentityProvider, signedInSite, type CookieMetadata } from "./sessionDetection";
import { accountsState } from "./accountsState";
import { profileAccounts } from "./accountsView";
import { useAccountCommand } from "./useAccounts";
import { isSigningIn } from "./useAccountBrowser";

const recorded = new Set<string>();

/**
 * Records a sign-in through Google, a university or another identity provider as a website
 * account for this profile, without asking: it holds no password, only the fact that the
 * profile is signed in there. A toast offers Undo.
 */
export function useSignInRecording(input: {
  environmentId: EnvironmentId;
  profileId: string;
  tabId: string;
  url: string;
  accounts: ReadonlyArray<AccountSummary>;
  enabled: boolean;
}) {
  const save = useAccountCommand(accountsState.save, input.environmentId);
  const remove = useAccountCommand(accountsState.remove, input.environmentId);
  const profiles = useClientSettings((settings) => settings.browserProfiles);
  const newTabProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const incognito =
    profiles.some((profile) => profile.id === input.profileId && profile.kind === "incognito") ||
    input.profileId === "incognito";
  const observation = useRef<{
    url: string;
    cookies: Promise<ReadonlyArray<CookieMetadata> | null>;
  } | null>(null);
  const inspect = useEffectEvent(
    (
      previousUrl: string,
      before: ReadonlyArray<CookieMetadata>,
      after: ReadonlyArray<CookieMetadata>,
    ) => {
      if (isSigningIn(input.environmentId, input.profileId, input.url)) return false;
      const site = signedInSite({
        previousUrl,
        url: input.url,
        before,
        after,
        incognito,
        hasAccount:
          profileAccounts(input.accounts, input.url, input.profileId, newTabProfileId).length > 0,
      });
      if (site === null) return false;
      const key = `${input.environmentId}:${input.profileId}:${site}`;
      if (recorded.has(key)) return true;
      recorded.add(key);
      const profileName = profiles.find((profile) => profile.id === input.profileId)?.name;
      void save({
        name: site,
        details: { kind: "website", sites: [site], profileId: input.profileId },
        secrets: {},
      }).then((result) => {
        if (!result.ok) return;
        toastManager.add({
          type: "success",
          title: `${site} saved to Accounts${profileName ? ` for ${profileName}` : ""}`,
          actionProps: {
            children: "Undo",
            onClick: () => void remove({ accountId: result.value.accountId }),
          },
        });
      });
      return true;
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe native cookie metadata across an IdP return; bound polling to five minutes and cancel on navigation or unmount.
  useEffect(() => {
    const bridge = window.desktopBridge?.accounts;
    if (!input.enabled || incognito || !bridge?.cookieMetadata) return;
    const read = () =>
      bridge.cookieMetadata!(input.profileId, input.environmentId).catch(() => null);
    if (isIdentityProvider(input.url)) {
      if (!observation.current) observation.current = { url: input.url, cookies: read() };
      return;
    }
    const previous = observation.current;
    if (!previous) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 300_000;
    const check = async () => {
      const [before, after] = await Promise.all([previous.cookies, read()]);
      if (!live) return;
      if (before && after && inspect(previous.url, before, after)) {
        observation.current = null;
      } else if (Date.now() < deadline) timer = setTimeout(() => void check(), 2_000);
      else observation.current = null;
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [input.environmentId, input.profileId, input.url, input.enabled, incognito]);
}
