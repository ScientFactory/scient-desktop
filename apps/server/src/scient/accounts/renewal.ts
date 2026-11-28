import { GOOGLE_SITE, type AccountId, type AccountSummary } from "@t3tools/contracts";
import { attemptKeys, signInHeld, signInStopped } from "@t3tools/shared/scientAccountSignIn";
import { siteUnder } from "@t3tools/shared/scientSiteMatch";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { forkParked } from "../../serverActivation.ts";
import { AccountsService } from "./AccountsService.ts";
import { renewAccount, worthChecking } from "./checkAccounts.ts";
import { mayAskCode, personActive, type SignInFactor } from "./signInCodes.ts";
import { signedOutHere } from "./signOuts.ts";

/** One row a turn, so the sites never see a burst of visits from this computer. */
const TURN = "10 minutes";
/** A row last seen this long ago is due a look. */
const DUE_MS = 24 * 60 * 60 * 1000;
/** Turns in a row the browser couldn't be reached for a row before it waits its day. */
const MOST_MISSES = 3;

/**
 * The rows due a turn, most overdue first. A row whose stop has lifted is due at once, by the
 * stop's own timing, unless renewal already tried it since; a held row isn't due; any other is
 * due a day after its last look or renewal, or, never seen, once it has been used. Google is left
 * to Google. Rows with uses come first, then the longest unseen.
 */
export function dueRenewals(
  accounts: ReadonlyArray<AccountSummary>,
  now: number,
  renewedAt: Readonly<Record<string, string>>,
) {
  const due = (account: AccountSummary) => {
    const renewed = Date.parse(renewedAt[account.accountId] ?? "") || Number.NEGATIVE_INFINITY;
    const { signIn } = account;
    if (signIn === undefined) return account.lastUsedAt !== undefined && now - renewed >= DUE_MS;
    if (signInHeld(account, now)) return false;
    if (signInStopped(signIn) && renewed < Date.parse(signIn.at)) return true;
    return now - Math.max(Date.parse(signIn.at), renewed) >= DUE_MS;
  };
  return accounts
    .filter(
      (account) =>
        account.details.kind === "website" &&
        // Google answers for its own sessions, and refuses sign-ins it didn't see a person make.
        !account.details.sites.some((site) => siteUnder(site, GOOGLE_SITE)) &&
        worthChecking(account) &&
        due(account),
    )
    .toSorted(
      (a, b) =>
        Number(b.lastUsedAt !== undefined) - Number(a.lastUsedAt !== undefined) ||
        (a.signIn?.at ?? "").localeCompare(b.signIn?.at ?? ""),
    );
}

/**
 * This turn's rows, each with whether it may only be looked at: with nobody at a window, a row that
 * may send a code (`mayAskCode`); the rest sign in silently. A row looked at and found signed out
 * goes first once someone is back (`deferred`). "Renew sign-ins automatically" off: only looks.
 */
export function renewalTurn(input: {
  readonly accounts: ReadonlyArray<AccountSummary>;
  readonly now: number;
  readonly renewedAt: Readonly<Record<string, string>>;
  readonly deferred: ReadonlySet<string>;
  readonly personActive: boolean;
  /** The second step each row's last sign-in met (`signInFactors`). */
  readonly factors: Readonly<Record<string, SignInFactor>>;
  readonly renewAutomatically: boolean;
}) {
  // A login that keeps one session is only looked at: signing in would end the person's own.
  const keyOf = attemptKeys(input.accounts);
  const oneSession = (account: AccountSummary) =>
    input.accounts.some(
      (row) =>
        keyOf(row) === keyOf(account) && row.details.kind === "website" && row.details.oneSession,
    );
  // A deferred row stays waiting through a look that couldn't tell (the site unreachable).
  const waiting =
    input.personActive && input.renewAutomatically
      ? input.accounts.filter(
          (account) =>
            input.deferred.has(account.accountId) &&
            (account.signIn?.state === "signed-out" ||
              account.signIn?.state === "unknown" ||
              account.signIn?.state === "needs-you") &&
            !signInHeld(account, input.now) &&
            !oneSession(account),
        )
      : [];
  return [...waiting, ...dueRenewals(input.accounts, input.now, input.renewedAt)].map((account) => {
    const kept = oneSession(account);
    const away = !input.personActive && mayAskCode(input.factors[account.accountId]);
    return {
      account,
      lookOnly: !input.renewAutomatically || kept || away,
      defers: input.renewAutomatically && !kept,
    };
  });
}

/**
 * Keeps sign-ins alive from the server, whether or not a window is open: each turn looks at the
 * most overdue row in its own profile and, if signed out, signs in once as Scient's own upkeep.
 * Each completed turn is recorded on the row, so the schedule survives restarts; a browser that
 * can't be reached is tried again next turn, a few times.
 */
export const accountRenewalLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment;
    const services = yield* Effect.context<AccountsService | PreviewAutomationBroker>();
    const misses = new Map<AccountId, number>();
    const turn = Effect.gen(function* () {
      const accounts = yield* AccountsService;
      // Unattended: never opens a store whose key would ask the person. Closed, the turn waits for
      // the change its first foreground use publishes (at most a turn) and asks again.
      while (!(yield* accounts.openWithoutPrompt))
        yield* accounts.changes.pipe(Stream.take(1), Stream.runDrain, Effect.timeoutOption(TURN));
      const snapshot = yield* accounts.snapshot;
      const now = yield* Clock.currentTimeMillis;
      const rows = renewalTurn({
        accounts: snapshot.accounts,
        now,
        renewedAt: yield* accounts.renewedAt,
        deferred: new Set(yield* accounts.deferredRenewals),
        personActive: yield* personActive,
        factors: yield* accounts.signInFactors,
        renewAutomatically: yield* accounts.renewAutomatically,
      });
      for (const { account, lookOnly, defers } of rows) {
        if (yield* signedOutHere(account)) continue;
        const seen = yield* renewAccount(account, yield* environment.getEnvironmentId, lookOnly);
        const looked = seen !== undefined;
        const after = (yield* accounts.snapshot).accounts.find(
          (row) => row.accountId === account.accountId,
        );
        // Kept until a turn with someone there settles it: a look that couldn't be made, or
        // couldn't tell (unreachable, unclear), keeps it.
        // Looked at only, or signed in with nobody there and left needing them (a code box the
        // saved key isn't known to answer): first once someone is back.
        if (
          defers &&
          ((lookOnly && after?.signIn?.state === "signed-out") ||
            (!lookOnly && after?.signIn?.state === "needs-you" && !(yield* personActive)))
        )
          yield* accounts.setRenewalDeferred(account.accountId, true);
        else if (!lookOnly && looked && seen !== "unknown")
          yield* accounts.setRenewalDeferred(account.accountId, false);
        const missed = looked ? 0 : (misses.get(account.accountId) ?? 0) + 1;
        if (missed > 0 && missed < MOST_MISSES) misses.set(account.accountId, missed);
        else {
          misses.delete(account.accountId);
          // Dated when the turn began, so a stop this turn recorded still gets its own retry.
          yield* accounts.renewed(account.accountId, DateTime.formatIso(DateTime.makeUnsafe(now)));
        }
        return;
      }
    }).pipe(Effect.ignore, Effect.withSpan("AccountsRenewal.turn"));
    yield* forkParked(
      Effect.sleep(TURN).pipe(
        Effect.andThen(turn),
        Effect.forever,
        Effect.provideContext(services),
      ),
    );
  }),
);
