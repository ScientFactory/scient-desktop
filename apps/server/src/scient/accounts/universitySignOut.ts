import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
  type EnvironmentId,
  type PreviewAutomationStatus,
  type UniversitySignOutInput,
  type UniversitySignOutTarget,
} from "@t3tools/contracts";
import { inSignOutTarget } from "@t3tools/shared/scientSiteMatch";
import { parseUrl } from "@t3tools/shared/url";
import * as Option from "effect/Option";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { PAPERS_THREAD } from "../papers/paperAttempt.ts";
import { previewInvoker } from "./agent/broker.ts";
import { CHECK_THREAD, userRunInvocation } from "./checkAccounts.ts";
import { attemptKeys } from "@t3tools/shared/scientAccountSignIn";
import { signOutTargets, universityMembership } from "@t3tools/shared/scientUniversityGroups";
import * as Effect from "effect/Effect";
import { withdrawUniversityFetches } from "../papers/universityFetches.ts";
import { retirePendingAttempts } from "./agent/guardedSignIn.ts";
import { AccountsService, fail } from "./AccountsService.ts";

/** Scient's own hidden tabs: papers' page loads and quiet looks, in their own threads. */
const SCIENT_THREADS = [PAPERS_THREAD, CHECK_THREAD];

/** Closes every tab Scient runs in a target's profile that is on that target's site or host. */
const closeScientTabs = Effect.fn("Accounts.universitySignOut.closeTabs")(function* (
  environmentId: EnvironmentId,
  targets: ReadonlyArray<UniversitySignOutTarget>,
) {
  const broker = yield* PreviewAutomationBroker;
  yield* Effect.forEach(
    SCIENT_THREADS,
    (threadId) =>
      Effect.gen(function* () {
        const invoke = previewInvoker(broker, userRunInvocation(threadId, environmentId), {
          updateCurrentTab: false,
        });
        const status = yield* invoke<PreviewAutomationStatus>("status", {}).pipe(Effect.option);
        const onTarget = (tab: {
          readonly url: string | null;
          readonly profileId?: string | undefined;
        }) => {
          const host = tab.url ? parseUrl(tab.url)?.hostname : undefined;
          return (
            host !== undefined &&
            targets.some(
              ({ profileId, site }) =>
                (tab.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId &&
                inSignOutTarget(host, site),
            )
          );
        };
        const tabs = Option.getOrUndefined(status)?.tabs?.filter(onTarget) ?? [];
        yield* Effect.forEach(tabs, (tab) => invoke("close", {}, tab.tabId).pipe(Effect.ignore), {
          discard: true,
        });
      }),
    { discard: true },
  );
});

/**
 * One membership's Sign out as one versioned operation, whose targets stay until reported cleared
 * by `opId`. One still open is given back with its original targets; the person's own sign-in ends
 * it, and its later reports change nothing.
 */
export const signOutUniversity = Effect.fn("Accounts.universitySignOut")(function* (
  input: UniversitySignOutInput,
  environmentId: EnvironmentId,
) {
  const accounts = yield* AccountsService;
  if (input.opId) {
    const settled = yield* accounts.settleSignOut(input.opId, input.cleared ?? []);
    return settled ? { opId: settled.opId, sites: settled.pending } : { sites: [] };
  }
  const before = yield* accounts.snapshot;
  const asked = universityMembership(before.accounts, input.accountId);
  if (!asked) return yield* fail("invalid-input", "Choose a university to sign out of.");
  const ids = asked.rows.map((row) => row.accountId);
  // A sign-in waiting on the person, or paused at a code, ends now; any other finishes before the
  // sign-out is recorded, under the same locks, so nothing in flight lands after it.
  yield* Effect.forEach(
    (before.handoffs ?? []).filter((handoff) => ids.includes(handoff.accountId)),
    (handoff) => accounts.cancelHandoff(handoff.handoffId).pipe(Effect.ignore),
    { discard: true },
  );
  yield* retirePendingAttempts(ids);
  const { exclusive } = yield* accounts.signInAttempts;
  // Keyed among every row, as sign-ins key them, so both take the same locks.
  const keysOf = (rows: ReadonlyArray<AccountSummary>, all: ReadonlyArray<AccountSummary>) =>
    [...new Set(rows.map(attemptKeys(all)))].toSorted();
  const holding = <A, E, R>(keys: ReadonlyArray<string>, then: Effect.Effect<A, E, R>) =>
    keys.reduce((held, key) => exclusive(key, held), then);
  const finish = Effect.fn("Accounts.universitySignOut.finish")(function* (
    rows: ReadonlyArray<AccountSummary>,
    all: ReadonlyArray<AccountSummary>,
  ) {
    const op = yield* accounts.beginSignOut(
      rows.map((row) => row.accountId),
      signOutTargets(rows, all),
    );
    // A paper's page load through the university stops, and every tab Scient runs on its sites
    // closes, before anything is cleared: nothing still loading sets a cookie after that.
    yield* withdrawUniversityFetches(op.accountIds);
    yield* closeScientTabs(environmentId, op.pending);
    // A sign-in that paused at a code while this waited for its lock ends too.
    yield* retirePendingAttempts(op.accountIds);
    // Each target is kept out of Main and deleted on the computers this profile is sent to, by
    // whole site or by host, as it is cleared here.
    yield* Effect.forEach(
      op.pending,
      ({ profileId, site }) => accounts.profileSignedOut(profileId, site),
      { discard: true },
    );
    return { opId: op.opId, sites: op.pending };
  });
  const keys = keysOf(asked.rows, before.accounts);
  return yield* holding(
    keys,
    Effect.gen(function* () {
      // Read again inside the locks: the rows and their sites may have changed meanwhile, and a
      // sign-in page learned since is another lock, held too.
      const all = (yield* accounts.snapshot).accounts;
      const membership = universityMembership(all, input.accountId);
      if (!membership) return yield* fail("invalid-input", "Choose a university to sign out of.");
      const learned = keysOf(membership.rows, all).filter((key) => !keys.includes(key));
      return yield* holding(learned, finish(membership.rows, all));
    }),
  );
});
