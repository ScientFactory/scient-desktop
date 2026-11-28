import { T, Var } from "gt-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isSignInProbe,
  universityDetails,
  universitySignInLink,
} from "@t3tools/shared/scientPaperLinks";
import { Spinner } from "~/components/ui/spinner";
import { useAccounts } from "./useAccounts";

/** The row a sign-in under way in this tab signs in to. */
function useAttemptAccount(threadRef: ScopedThreadRef, tabId: string | null | undefined) {
  const { data } = useAccounts(threadRef.environmentId);
  const attempt = data?.attempts?.find(
    (item) => item.tabId === tabId && item.threadId === threadRef.threadId,
  );
  return attempt && data?.accounts.find((row) => row.accountId === attempt.accountId);
}

/**
 * Where a refused or dropped Google sign-in in this tab starts again, in the Chrome window, the
 * person's browser and this tab: a university sign-in under way at its own entry route, which the
 * attempt then follows and checks; anything else where Google's refusal said.
 */
export function useUniversityRestart(
  threadRef: ScopedThreadRef,
  tabId: string | null | undefined,
  refusedAt: string | null,
) {
  const details = useAttemptAccount(threadRef, tabId)?.details;
  const university = details && universityDetails(details);
  return (university && universitySignInLink(university)) ?? refusedAt;
}

/**
 * Covers a university sign-in's tab while it passes the publisher Scient asks for the sign-in, so
 * the person sees their university, never an unrelated journal's home page.
 */
export function UniversitySignInCover({
  threadRef,
  tabId,
  url,
}: {
  threadRef: ScopedThreadRef;
  tabId: string;
  url: string;
}) {
  const account = useAttemptAccount(threadRef, tabId);
  if (!account || !isSignInProbe(url)) return null;
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
      <Spinner size="sm" tone="muted" />
      <T>
        Signing in to <Var>{account.name}</Var>
      </T>
    </div>
  );
}
