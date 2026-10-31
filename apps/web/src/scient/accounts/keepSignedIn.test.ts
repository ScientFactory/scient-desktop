import {
  AccountId,
  defaultAccountControls,
  type AccountCheckState,
  type AccountSummary,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { afterVisit, nextQuietVisit, sessionEnded, type QuietVisits } from "./keepSignedIn";

const HOUR = 60 * 60 * 1000;
const account = (id: string, site: string, state: AccountCheckState): AccountSummary => ({
  accountId: AccountId.make(`acc_fixture${id}`),
  name: site,
  details: { kind: "website", sites: [site], profileId: "work" },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  lastCheck: { state, at: "2026-10-31T00:00:00.000Z" },
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
});

it("visits the most overdue live sign-in, and leaves Google and ended sessions alone", () => {
  const github = account("github", "github.com", "signed-in");
  const overleaf = account("overleaf", "https://www.overleaf.com", "signed-in");
  const accounts = [
    account("google", "google.com", "signed-in"),
    account("gmail", "mail.google.com", "signed-in"),
    account("ended", "nature.com", "signed-out"),
    github,
    overleaf,
  ];
  const now = 100 * HOUR;
  expect(nextQuietVisit(accounts, {}, now)).toMatchObject({
    accountId: github.accountId,
    profileId: "work",
    url: "https://github.com/",
  });
  const visits: QuietVisits = { [github.accountId]: { at: now - HOUR, gapMs: 24 * HOUR } };
  expect(nextQuietVisit(accounts, visits, now)).toMatchObject({
    accountId: overleaf.accountId,
    url: "https://www.overleaf.com",
  });
  expect(
    nextQuietVisit(
      accounts,
      { ...visits, [overleaf.accountId]: { at: now, gapMs: 24 * HOUR } },
      now,
    ),
  ).toBeUndefined();
});

it("reads the end of a session from where the site sent the request", () => {
  expect(sessionEnded("https://github.com/", "https://github.com/login", 200)).toBe(true);
  expect(sessionEnded("https://a.example/", "https://sso.example/start", 200)).toBe(true);
  expect(sessionEnded("https://a.example/", "https://a.example/", 401)).toBe(true);
  expect(sessionEnded("https://github.com/", "https://github.com/", 200)).toBe(false);
  // A site whose own address looks like a sign-in page proves nothing by staying there.
  expect(sessionEnded("https://sso.example/", "https://sso.example/home", 200)).toBe(false);
});

it("visits sooner after a session ended, never closer than six hours", () => {
  const first = afterVisit(undefined, false, 0);
  expect(first.gapMs).toBe(24 * HOUR);
  const halved = afterVisit(first, true, 0);
  expect(halved.gapMs).toBe(12 * HOUR);
  expect(afterVisit(afterVisit(halved, true, 0), true, 0).gapMs).toBe(6 * HOUR);
  expect(afterVisit(halved, false, 0).gapMs).toBe(12 * HOUR);
});
