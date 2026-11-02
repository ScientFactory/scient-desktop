import { useEffect, useEffectEvent } from "react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { universitiesOf, universityDetails } from "@t3tools/shared/scientPaperLinks";
import { accountsState } from "./accountsState";
import { useAccountCommand } from "./useAccounts";

/** Long enough for an article page to name its DOI. */
const PAGE_SETTLE_MS = 2_500;

/** Whether a university the person is signed in to lives in this profile. */
const signedInUniversityHere = (accounts: ReadonlyArray<AccountSummary>, profileId: string) =>
  universitiesOf(accounts).some(
    (account) =>
      account.lastCheck?.state === "signed-in" &&
      (universityDetails(account.details)?.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId,
  );

/**
 * Brings a journal article the person opened in through their university, once per journal: the
 * server reloads it on the university's way in when the page is an article. Pages outside
 * journals never leave this computer.
 */
export function useUniversityBrowsing(input: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  tabId: string;
  profileId: string;
  url: string;
  accounts: ReadonlyArray<AccountSummary>;
  enabled: boolean;
}) {
  const browse = useAccountCommand(accountsState.universityBrowse, input.environmentId);
  const ask = useEffectEvent((url: string) => {
    if (!signedInUniversityHere(input.accounts, input.profileId)) return;
    void browse({
      threadId: input.threadRef.threadId,
      tabId: input.tabId,
      profileId: input.profileId,
      url,
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Ask once the page has settled on an address; a newer address cancels the question.
  useEffect(() => {
    if (!input.enabled || !input.url.startsWith("https://")) return;
    const timer = setTimeout(() => ask(input.url), PAGE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [input.enabled, input.url]);
}
