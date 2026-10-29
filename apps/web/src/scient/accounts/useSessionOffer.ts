import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { AccountSummary, EnvironmentId } from "@t3tools/contracts";
import { useClientSettings } from "~/hooks/useSettings";
import {
  isIdentityProvider,
  shouldOfferSession,
  siteHost,
  type CookieMetadata,
} from "./sessionDetection";
import { profileAccounts } from "./accountsView";
import { isSigningIn } from "./useAccountBrowser";

const offered = new Set<string>();

export function useSessionOffer(input: {
  environmentId: EnvironmentId;
  profileId: string;
  tabId: string;
  url: string;
  accounts: ReadonlyArray<AccountSummary>;
  enabled: boolean;
}) {
  const [offer, setOffer] = useState<string | null>(null);
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
      const id = `${input.environmentId}:${input.profileId}:${siteHost(input.url)}`;
      if (isSigningIn(input.environmentId, input.profileId, input.url)) return false;
      if (
        shouldOfferSession({
          previousUrl,
          url: input.url,
          before,
          after,
          incognito,
          hasAccount:
            profileAccounts(input.accounts, input.url, input.profileId, newTabProfileId).length > 0,
          offered: offered.has(id),
        })
      ) {
        offered.add(id);
        setOffer(input.url);
        return true;
      }
      return false;
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
  return { offer, close: () => setOffer(null) };
}
