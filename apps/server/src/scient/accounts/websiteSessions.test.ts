import { expect, it } from "vite-plus/test";
import { AccountId, defaultAccountControls, type AccountSummary } from "@t3tools/contracts";
import { endedWebsiteSessions } from "./websiteSessions.ts";
const account: AccountSummary = {
  accountId: AccountId.make("acc_synthetic01"),
  name: "Synthetic",
  details: {
    kind: "website",
    sites: ["https://login.example.com", "other.test"],
    profileId: "work",
  },
  secrets: {},
  controls: defaultAccountControls("website"),
  status: "ready",
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  signIn: { state: "signed-in", at: "1970-01-01T00:00:00.000Z" },
};
const now = 2_000_000;
it("requires metadata for the account profile and excludes expired and unrelated cookies", () => {
  const check = (sessions: Parameters<typeof endedWebsiteSessions>[1]) =>
    endedWebsiteSessions([account], sessions, new Set(), now).includes(account.accountId);
  expect(check([])).toBe(false);
  expect(check([{ profileId: "default", cookies: [] }])).toBe(false);
  expect(check([{ profileId: "work", cookies: [] }])).toBe(true);
  // Cookies read before a sign-in moments ago say nothing about it.
  const justSignedIn = {
    ...account,
    signIn: { state: "signed-in" as const, at: "1970-01-01T00:32:20.000Z" },
  };
  expect(
    endedWebsiteSessions([justSignedIn], [{ profileId: "work", cookies: [] }], new Set(), now),
  ).toEqual([]);
  expect(
    check([{ profileId: "work", cookies: [{ domain: "login.example.com", expires: now / 1000 }] }]),
  ).toBe(true);
  expect(check([{ profileId: "work", cookies: [{ domain: "example.com.attacker.test" }] }])).toBe(
    true,
  );
  expect(
    check([{ profileId: "work", cookies: [{ domain: ".example.com", expires: now / 1000 + 1 }] }]),
  ).toBe(false);
  expect(check([{ profileId: "work", cookies: [{ domain: "other.test", expires: -1 }] }])).toBe(
    false,
  );
});
it("remembers a possible manual session but never infers prior use from an empty profile", () => {
  const { signIn: _signIn, ...manual } = account;
  const observed = new Set<string>();
  const read = (cookies: Parameters<typeof endedWebsiteSessions>[1][number]["cookies"]) =>
    endedWebsiteSessions(
      [manual],
      [{ profileId: "work", cookies }],
      observed,
      now,
      "synthetic-desktop",
    ).includes(manual.accountId);
  expect(read([])).toBe(false);
  expect(read([{ domain: "login.example.com" }])).toBe(false);
  expect(read([])).toBe(true);
  expect(
    endedWebsiteSessions(
      [manual],
      [{ profileId: "work", cookies: [] }],
      observed,
      now,
      "other-desktop",
    ),
  ).toEqual([]);
  expect(endedWebsiteSessions([manual], [], observed, now, "synthetic-desktop")).toEqual([]);
  const moved = {
    ...manual,
    details: { kind: "website" as const, sites: ["different.test"], profileId: "work" },
  };
  expect(
    endedWebsiteSessions(
      [moved],
      [{ profileId: "work", cookies: [] }],
      observed,
      now,
      "synthetic-desktop",
    ),
  ).toEqual([]);
});

it("treats a site's protected cookie as its session once seen, ignoring leftover analytics", () => {
  const observed = new Set<string>();
  const status = (cookies: ReadonlyArray<{ domain: string; httpOnly?: boolean }>) =>
    endedWebsiteSessions(
      [account],
      [{ profileId: "work", cookies }],
      observed,
      now,
      "synthetic-desktop",
    ).includes(account.accountId);
  expect(
    status([{ domain: "login.example.com", httpOnly: true }, { domain: ".login.example.com" }]),
  ).toBe(false);
  expect(status([{ domain: ".login.example.com", httpOnly: false }])).toBe(true);
  expect(status([])).toBe(true);
});
