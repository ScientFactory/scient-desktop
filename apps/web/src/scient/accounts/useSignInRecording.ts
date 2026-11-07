import { useEffect, useEffectEvent, useRef } from "react";
import type { AccountSummary, EnvironmentId } from "@t3tools/contracts";
import { signInReturn, universitiesOf } from "@t3tools/shared/scientPaperLinks";
import { useClientSettings } from "~/hooks/useSettings";
import { toastManager } from "~/components/ui/toast";
import { isIdentityProvider, signedInSite, type CookieMetadata } from "./sessionDetection";
import { accountsState } from "./accountsState";
import { profileAccounts } from "./accountsView";
import { useAccountCommand } from "./useAccounts";

/** Returns being recorded now, so two views of one tab record it once. */
const recording = new Set<string>();

/**
 * Records a sign-in through Google, a university or another identity provider on this profile's
 * session row for the site, without asking: the row holds no password, only the fact that the
 * profile is signed in there. A new row gets a toast offering Undo.
 */
export function useSignInRecording(input: {
  environmentId: EnvironmentId;
  profileId: string;
  tabId: string;
  url: string;
  accounts: ReadonlyArray<AccountSummary>;
  /** The server keeps sessions seen (`accounts.sessionsSeen`); an older one only saves rows. */
  sessionsSeen: boolean;
  /** This tab's sign-in is Scient's own while it runs: its outcome is recorded there. */
  signingIn: boolean;
  enabled: boolean;
}) {
  const seen = useAccountCommand(accountsState.sessionsSeen, input.environmentId);
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
    announced?: boolean;
  } | null>(null);
  const record = async (site: string) => {
    if (input.sessionsSeen) {
      const result = await seen({
        profileId: input.profileId,
        sessions: [{ site, how: "signed-in" }],
      });
      return result.ok ? result.value.created[0] : undefined;
    }
    if (profileAccounts(input.accounts, input.url, input.profileId, newTabProfileId).length > 0)
      return undefined;
    const result = await save({
      name: site,
      details: {
        kind: "website",
        sites: [site],
        profileId: input.profileId,
        origin: "browser-session",
      },
      secrets: {},
    });
    return result.ok ? result.value.accountId : undefined;
  };
  const inspect = useEffectEvent(
    (
      previousUrl: string,
      before: ReadonlyArray<CookieMetadata>,
      after: ReadonlyArray<CookieMetadata>,
    ) => {
      if (input.signingIn) return false;
      // Where a university's own sign-in link lands is that sign-in, not a new site.
      if (universitiesOf(input.accounts).length > 0 && signInReturn(input.url)) return false;
      const site = signedInSite({ previousUrl, url: input.url, before, after, incognito });
      if (site === null) return false;
      const key = `${input.environmentId}:${input.profileId}:${site}`;
      if (recording.has(key)) return true;
      recording.add(key);
      const profileName = profiles.find((profile) => profile.id === input.profileId)?.name;
      void record(site)
        .then((created) => {
          if (!created) return;
          toastManager.add({
            type: "success",
            title: `${site} saved to Accounts${profileName ? ` for ${profileName}` : ""}`,
            actionProps: {
              children: "Undo",
              onClick: () => void remove({ accountId: created }),
            },
          });
        })
        .finally(() => recording.delete(key));
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
    if (!previous.announced) {
      previous.announced = true;
      window.dispatchEvent(new Event("scient-accounts-session-changed"));
    }
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
