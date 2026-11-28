import { AccountId, type AccountSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { dueRenewals, renewalTurn } from "./renewal.ts";

const now = Date.UTC(2026, 10, 26, 10);
const daysAgo = (days: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - days * 24 * 60 * 60 * 1000));

const row = (id: string, fields: Partial<AccountSummary> = {}) =>
  ({
    accountId: AccountId.make(`acc_${id}_fixture`),
    name: id,
    details: { kind: "website", sites: ["example.com"], username: "someone" },
    secrets: { password: { source: { type: "scient" } } },
    ...fields,
  }) as AccountSummary;

describe("which sign-in Scient renews next", () => {
  it("only rows not seen for a day, used ones first, then the longest unseen", () => {
    const due = dueRenewals(
      [
        row("seen-today", { signIn: { state: "signed-in", at: daysAgo(0.5) } }),
        row("old", { signIn: { state: "signed-in", at: daysAgo(5) } }),
        row("older", { signIn: { state: "signed-in", at: daysAgo(9) } }),
        row("used", { signIn: { state: "signed-in", at: daysAgo(2) }, lastUsedAt: daysAgo(2) }),
        // An imported password nobody used is checked only on request.
        row("never-used"),
        // Google, whatever the row holds, is left to Google.
        row("google", {
          signIn: { state: "signed-in", at: daysAgo(9) },
          lastUsedAt: daysAgo(9),
          details: { kind: "website", sites: ["accounts.google.com"], username: "someone" },
        }),
      ],
      now,
      {},
    );
    expect(due.map(({ name }) => name)).toEqual(["used", "older", "old"]);
  });

  it("follows the stop's own timing: a lifted failure at once, a held row never", () => {
    const failed = row("failed", { signIn: { state: "failed", at: daysAgo(0.03) } });
    const refused = row("refused", { signIn: { state: "password-rejected", at: daysAgo(30) } });
    // Forty-odd minutes after one failure it is due, though it was seen today.
    expect(dueRenewals([failed, refused], now, {}).map(({ name }) => name)).toEqual(["failed"]);
    // Tried since that failure: it waits its day like any other row.
    expect(dueRenewals([failed], now, { [failed.accountId]: daysAgo(0.01) })).toEqual([]);
  });

  it("a stop renewal itself recorded still gets its first retry", () => {
    // The turn began, then its sign-in failed: the failure is newer than the turn.
    const failed = row("failed", { signIn: { state: "failed", at: daysAgo(0.03) } });
    expect(dueRenewals([failed], now, { [failed.accountId]: daysAgo(0.031) })).toEqual([failed]);
  });

  it("never looks at the same row twice in a day, across restarts", () => {
    const seen = row("seen", { signIn: { state: "unknown", at: daysAgo(3) } });
    const renewedAt = { [seen.accountId]: daysAgo(0.5) };
    expect(dueRenewals([seen], now, renewedAt)).toEqual([]);
    expect(dueRenewals([seen], now + 24 * 60 * 60 * 1000, renewedAt)).toEqual([seen]);
  });

  it("with nobody at a window, signs in silently only where no code can come; the rest wait", () => {
    const signedOut = { signIn: { state: "signed-out" as const, at: daysAgo(2) } };
    // gov.il texted a code last time; `fresh` has shown nothing either way and has no key.
    const gov = row("gov", signedOut);
    const fresh = row("fresh", signedOut);
    const quiet = row("quiet", signedOut);
    const withKey = {
      ...signedOut,
      secrets: { password: { source: { type: "scient" } }, totp: { source: { type: "scient" } } },
    } as Partial<AccountSummary>;
    // `keyed` was seen signing in with its key alone; `untried` only has a key saved.
    const keyed = row("keyed", withKey);
    const untried = row("untried", withKey);
    const factors = {
      [gov.accountId]: "code",
      [quiet.accountId]: "none",
      [keyed.accountId]: "totp",
    } as const;
    const turn = (personActive: boolean, renewAutomatically = true) =>
      renewalTurn({
        accounts: [gov, fresh, quiet, keyed, untried],
        now,
        renewedAt: {},
        deferred: new Set<string>(),
        personActive,
        factors,
        renewAutomatically,
      }).map(({ account, lookOnly }) => [account.name, lookOnly]);
    // regression: every row only got a look while nobody was there, so lapsed sign-ins waited.
    expect(turn(false)).toEqual([
      ["gov", true],
      ["fresh", true],
      ["quiet", false],
      ["keyed", false],
      // regression: a saved key alone made a row quiet.
      ["untried", true],
    ]);
    expect(turn(true).every(([, lookOnly]) => lookOnly === false)).toBe(true);
    // "Renew sign-ins automatically" off: only looks, whoever is there.
    expect(turn(true, false).every(([, lookOnly]) => lookOnly === true)).toBe(true);
    // Back at a window: the row that only got a look goes first, and may sign in now.
    const looked = { ...gov, signIn: { state: "signed-out" as const, at: daysAgo(0) } };
    expect(
      renewalTurn({
        accounts: [looked],
        now,
        renewedAt: {},
        deferred: new Set([looked.accountId]),
        personActive: true,
        factors,
        renewAutomatically: true,
      }).map(({ account, lookOnly }) => [account.name, lookOnly]),
    ).toEqual([["gov", false]]);
  });

  it("never renews a row whose password the site refused, whatever it sees after", () => {
    const refused = row("refused", {
      signIn: { state: "signed-out", at: daysAgo(3) },
      secrets: { password: { source: { type: "scient" }, refusedAt: daysAgo(3) } },
    } as Partial<AccountSummary>);
    expect(
      renewalTurn({
        accounts: [refused],
        now,
        renewedAt: {},
        deferred: new Set([refused.accountId]),
        personActive: true,
        factors: {},
        renewAutomatically: true,
      }),
    ).toEqual([]);
  });

  it("only looks at a login that keeps one session, even with someone there, and keeps no reminder", () => {
    const orbit = row("orbit", {
      signIn: { state: "signed-out", at: daysAgo(2) },
      details: { kind: "website", sites: ["example.com"], username: "someone", oneSession: true },
    });
    // regression: upkeep signed in there, ending the person's own session, or asked them to.
    expect(
      renewalTurn({
        accounts: [orbit],
        now,
        renewedAt: {},
        deferred: new Set([orbit.accountId]),
        personActive: true,
        factors: {},
        renewAutomatically: true,
      }),
    ).toEqual([{ account: orbit, lookOnly: true, defers: false }]);
  });
});
