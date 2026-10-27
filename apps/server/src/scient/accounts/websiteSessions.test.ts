import { expect, it } from "vite-plus/test";
import { AccountId, defaultAccountControls, type AccountSummary } from "@t3tools/contracts";
import { websiteSessionStatus } from "./websiteSessions.ts";
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
  lastSignInOutcome: "signed-in",
};
const now = 2_000_000;
it("requires metadata for the account profile and excludes expired and unrelated cookies", () => {
  const check = (sessions: Parameters<typeof websiteSessionStatus>[1]) =>
    websiteSessionStatus([account], sessions, new Set(), now)[0]?.signedOut;
  expect(check([])).toBeUndefined();
  expect(check([{ profileId: "default", cookies: [] }])).toBeUndefined();
  expect(check([{ profileId: "work", cookies: [] }])).toBe(true);
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
  const manual = { ...account, lastSignInOutcome: undefined };
  const observed = new Set<string>();
  const read = (cookies: Parameters<typeof websiteSessionStatus>[1][number]["cookies"]) =>
    websiteSessionStatus(
      [manual],
      [{ profileId: "work", cookies }],
      observed,
      now,
      "synthetic-desktop",
    )[0];
  expect(read([])?.signedOut).toBe(false);
  expect(read([{ domain: "login.example.com" }])?.signedOut).toBe(false);
  expect(read([])?.signedOut).toBe(true);
  expect(
    websiteSessionStatus(
      [manual],
      [{ profileId: "work", cookies: [] }],
      observed,
      now,
      "other-desktop",
    )[0]?.signedOut,
  ).toBe(false);
  expect(
    websiteSessionStatus([manual], [], observed, now, "synthetic-desktop")[0]?.signedOut,
  ).toBeUndefined();
  const moved = {
    ...manual,
    details: { kind: "website" as const, sites: ["different.test"], profileId: "work" },
  };
  expect(
    websiteSessionStatus(
      [moved],
      [{ profileId: "work", cookies: [] }],
      observed,
      now,
      "synthetic-desktop",
    )[0]?.signedOut,
  ).toBe(false);
});
